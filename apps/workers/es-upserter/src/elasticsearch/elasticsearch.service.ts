import { createHash } from "node:crypto";
import { Client } from "@elastic/elasticsearch";
import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import {
	ELASTICSEARCH_CONFIG,
	type ElasticsearchConfig,
} from "./elasticsearch.config.js";

export const ELASTICSEARCH_SERVICE = "ELASTICSEARCH_SERVICE";

export interface IndexResult {
	success: boolean;
	isUpdate: boolean;
	error?: string;
}

@Injectable()
export class ElasticsearchService implements OnModuleDestroy {
	private client: Client | null = null;
	private indexExists = false;

	constructor(
		@Inject(ELASTICSEARCH_CONFIG)
		private readonly config: ElasticsearchConfig,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	/**
	 * Generate deterministic document ID for idempotency.
	 * Uses sha256(email_id:chunk_hash:embedding_version) truncated to 20 hex chars.
	 */
	static generateDocId(
		emailId: string,
		chunkHash: string,
		embeddingVersion: string,
	): string {
		const input = `${emailId}:${chunkHash}:${embeddingVersion}`;
		return createHash("sha256").update(input).digest("hex").slice(0, 20);
	}

	/**
	 * Get or create Elasticsearch client (lazy initialization)
	 */
	private getClient(): Client {
		if (this.client) {
			return this.client;
		}

		const clientOpts: ConstructorParameters<typeof Client>[0] = {
			requestTimeout: this.config.requestTimeoutMs,
		};

		if (this.config.cloudId) {
			clientOpts.cloud = { id: this.config.cloudId };
			this.logger.info("Connecting to Elasticsearch Cloud", {
				index: this.config.index,
			});
		} else {
			clientOpts.node = this.config.node;
			this.logger.info("Connecting to Elasticsearch", {
				node: this.config.node,
				index: this.config.index,
			});
		}

		if (this.config.apiKey) {
			clientOpts.auth = { apiKey: this.config.apiKey };
		}

		this.client = new Client(clientOpts);
		return this.client;
	}

	/**
	 * Check if a document already exists (idempotency check)
	 */
	async documentExists(docId: string): Promise<boolean> {
		const client = this.getClient();
		try {
			return await client.exists({
				index: this.config.index,
				id: docId,
			});
		} catch {
			return false;
		}
	}

	/**
	 * Index or update a document in Elasticsearch
	 */
	async indexDocument(
		docId: string,
		document: Record<string, unknown>,
	): Promise<IndexResult> {
		const client = this.getClient();
		try {
			const response = await client.index({
				index: this.config.index,
				id: docId,
				document,
			});

			return {
				success: true,
				isUpdate: response.result === "updated",
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this.logger.error(
				"Elasticsearch index failed",
				errorMsg,
				JSON.stringify({ doc_id: docId }),
			);
			return {
				success: false,
				isUpdate: false,
				error: errorMsg,
			};
		}
	}

	/**
	 * Ensure the index exists with proper mapping for dense_vector
	 */
	async ensureIndex(dimensions: number): Promise<void> {
		if (this.indexExists) {
			return;
		}

		const client = this.getClient();

		const exists = await client.indices.exists({
			index: this.config.index,
		});

		if (exists) {
			this.logger.info("Index already exists", {
				index: this.config.index,
			});
			this.indexExists = true;
			return;
		}

		this.logger.info("Creating Elasticsearch index", {
			index: this.config.index,
			dimensions,
		});

		await client.indices.create({
			index: this.config.index,
			mappings: {
				properties: {
					doc_id: { type: "keyword" },
					tenant_id: { type: "keyword" },
					account_id: { type: "keyword" },
					alias: { type: "keyword" },
					email_id: { type: "keyword" },
					chunk_hash: { type: "keyword" },
					embedding_version: { type: "keyword" },
					embedding_model: { type: "keyword" },
					section_type: { type: "keyword" },
					email_timestamp: { type: "date" },
					chunk_text: { type: "text", analyzer: "standard" },
					vector: {
						type: "dense_vector",
						dims: dimensions,
						index: true,
						similarity: "cosine",
					},
					indexed_at: { type: "date" },
				},
			},
		});

		this.logger.info("Index created", { index: this.config.index });
		this.indexExists = true;
	}

	/**
	 * Health check via cluster health API
	 */
	async healthCheck(): Promise<boolean> {
		try {
			const client = this.getClient();
			const health = await client.cluster.health();
			return health.status === "green" || health.status === "yellow";
		} catch {
			return false;
		}
	}

	/**
	 * Get the configured index name
	 */
	getIndexName(): string {
		return this.config.index;
	}

	async onModuleDestroy(): Promise<void> {
		if (this.client) {
			await this.client.close();
			this.client = null;
		}
	}
}
