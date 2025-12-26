import { createHash } from "node:crypto";
import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { DataType, MilvusClient } from "@zilliz/milvus2-sdk-node";
import { MILVUS_CONFIG, type MilvusConfig } from "./milvus.config.js";

export const MILVUS_SERVICE = "MILVUS_SERVICE";

export interface VectorRecord {
	/** Deterministic primary key: sha256(email_id + chunk_hash + embedding_version) */
	pk: string;
	/** Tenant identifier */
	tenantId: string;
	/** Account identifier */
	accountId: string;
	/** Optional alias */
	alias?: string;
	/** Email ID */
	emailId: string;
	/** Chunk hash */
	chunkHash: string;
	/** Embedding version */
	embeddingVersion: string;
	/** Embedding model ID */
	embeddingModel: string;
	/** Section type (body, header, etc.) */
	sectionType?: string;
	/** Email sent/received timestamp as unix epoch */
	emailTimestamp?: number;
	/** Vector data */
	vector: number[];
}

export interface UpsertResult {
	pk: string;
	success: boolean;
	isUpdate: boolean;
	error?: string;
}

@Injectable()
export class MilvusService implements OnModuleDestroy {
	private client: MilvusClient | null = null;
	private collectionExists = false;

	constructor(
		@Inject(MILVUS_CONFIG) private readonly config: MilvusConfig,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	/**
	 * Generate deterministic primary key for idempotency
	 */
	static generatePK(
		emailId: string,
		chunkHash: string,
		embeddingVersion: string,
	): string {
		const input = `${emailId}:${chunkHash}:${embeddingVersion}`;
		return createHash("sha256").update(input).digest("hex");
	}

	/**
	 * Get or create Milvus client
	 */
	private async getClient(): Promise<MilvusClient> {
		if (this.client) {
			return this.client;
		}

		this.logger.info("Connecting to Milvus", {
			address: this.config.address,
			collection: this.config.collection,
		});

		this.client = new MilvusClient({
			address: this.config.address,
			timeout: this.config.connectTimeoutMs,
		});

		// Verify connection
		const health = await this.client.checkHealth();
		if (!health.isHealthy) {
			throw new Error(`Milvus is not healthy: ${JSON.stringify(health)}`);
		}

		this.logger.info("Connected to Milvus successfully");
		return this.client;
	}

	/**
	 * Ensure collection exists with proper schema
	 */
	async ensureCollection(): Promise<void> {
		if (this.collectionExists) {
			return;
		}

		const client = await this.getClient();

		// Check if collection exists
		const hasCollection = await client.hasCollection({
			collection_name: this.config.collection,
		});

		if (hasCollection.value) {
			this.logger.info("Collection already exists", {
				collection: this.config.collection,
			});
			this.collectionExists = true;
			return;
		}

		this.logger.info("Creating Milvus collection", {
			collection: this.config.collection,
			dimension: this.config.dimension,
			indexType: this.config.indexType,
		});

		// Create collection with schema
		await client.createCollection({
			collection_name: this.config.collection,
			fields: [
				{
					name: "pk",
					description: "Primary key (sha256 hash)",
					data_type: DataType.VarChar,
					is_primary_key: true,
					max_length: 64,
				},
				{
					name: "tenant_id",
					description: "Tenant identifier",
					data_type: DataType.VarChar,
					max_length: 255,
				},
				{
					name: "account_id",
					description: "Account identifier",
					data_type: DataType.VarChar,
					max_length: 255,
				},
				{
					name: "alias",
					description: "Account alias",
					data_type: DataType.VarChar,
					max_length: 255,
				},
				{
					name: "email_id",
					description: "Email UUID",
					data_type: DataType.VarChar,
					max_length: 36,
				},
				{
					name: "chunk_hash",
					description: "Chunk content hash",
					data_type: DataType.VarChar,
					max_length: 64,
				},
				{
					name: "embedding_version",
					description: "Embedding algorithm version",
					data_type: DataType.VarChar,
					max_length: 50,
				},
				{
					name: "embedding_model",
					description: "Embedding model identifier",
					data_type: DataType.VarChar,
					max_length: 100,
				},
				{
					name: "section_type",
					description: "Semantic section type",
					data_type: DataType.VarChar,
					max_length: 30,
				},
				{
					name: "email_timestamp",
					description: "Email sent/received timestamp (unix epoch)",
					data_type: DataType.Int64,
				},
				{
					name: "vector",
					description: "Embedding vector",
					data_type: DataType.FloatVector,
					dim: this.config.dimension,
				},
			],
		});

		// Create HNSW index on vector field
		await client.createIndex({
			collection_name: this.config.collection,
			field_name: "vector",
			index_type: this.config.indexType,
			metric_type: this.config.metricType,
			params: {
				M: this.config.hnswM,
				efConstruction: this.config.hnswEfConstruction,
			},
		});

		// Load collection into memory
		await client.loadCollection({
			collection_name: this.config.collection,
		});

		this.logger.info("Collection created and loaded", {
			collection: this.config.collection,
		});

		this.collectionExists = true;
	}

	/**
	 * Check if vectors exist by primary keys (for idempotency)
	 */
	async getExistingPKs(pks: string[]): Promise<Set<string>> {
		if (pks.length === 0) {
			return new Set();
		}

		const client = await this.getClient();
		await this.ensureCollection();

		try {
			const result = await client.query({
				collection_name: this.config.collection,
				filter: `pk in [${pks.map((pk) => `"${pk}"`).join(",")}]`,
				output_fields: ["pk"],
			});

			const existingPKs = new Set<string>();
			for (const row of result.data) {
				if (row["pk"]) {
					existingPKs.add(row["pk"] as string);
				}
			}

			return existingPKs;
		} catch (error) {
			// If query fails, assume none exist (will be handled by upsert)
			this.logger.warn("Failed to query existing PKs", {
				error: error instanceof Error ? error.message : String(error),
			});
			return new Set();
		}
	}

	/**
	 * Upsert vectors to Milvus
	 */
	async upsert(records: VectorRecord[]): Promise<UpsertResult[]> {
		if (records.length === 0) {
			return [];
		}

		const client = await this.getClient();
		await this.ensureCollection();

		// Check which PKs already exist for is_update tracking
		const pks = records.map((r) => r.pk);
		const existingPKs = await this.getExistingPKs(pks);

		// Validate dimensions
		for (const record of records) {
			if (record.vector.length !== this.config.dimension) {
				return records.map((r) => ({
					pk: r.pk,
					success: false,
					isUpdate: existingPKs.has(r.pk),
					error: `Dimension mismatch: expected ${this.config.dimension}, got ${record.vector.length}`,
				}));
			}
		}

		// Prepare data for upsert
		const data = records.map((r) => ({
			pk: r.pk,
			tenant_id: r.tenantId,
			account_id: r.accountId,
			alias: r.alias ?? "",
			email_id: r.emailId,
			chunk_hash: r.chunkHash,
			embedding_version: r.embeddingVersion,
			embedding_model: r.embeddingModel,
			section_type: r.sectionType ?? "",
			email_timestamp: r.emailTimestamp ?? 0,
			vector: r.vector,
		}));

		try {
			// Use upsert for idempotent operation
			const result = await client.upsert({
				collection_name: this.config.collection,
				data,
			});

			if (result.status.error_code !== "Success") {
				throw new Error(
					`Milvus upsert failed: ${result.status.reason || result.status.error_code}`,
				);
			}

			return records.map((r) => ({
				pk: r.pk,
				success: true,
				isUpdate: existingPKs.has(r.pk),
			}));
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this.logger.error("Milvus upsert failed", errorMsg, "{}");

			return records.map((r) => ({
				pk: r.pk,
				success: false,
				isUpdate: existingPKs.has(r.pk),
				error: errorMsg,
			}));
		}
	}

	/**
	 * Health check
	 */
	async healthCheck(): Promise<boolean> {
		try {
			const client = await this.getClient();
			const health = await client.checkHealth();
			return health.isHealthy;
		} catch {
			return false;
		}
	}

	async onModuleDestroy(): Promise<void> {
		if (this.client) {
			await this.client.closeConnection();
			this.client = null;
		}
	}
}
