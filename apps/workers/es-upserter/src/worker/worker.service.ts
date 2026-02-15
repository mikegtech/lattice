import type { MailEmbedPayload } from "@lattice/core-contracts";
import {
	BaseWorkerService,
	type KafkaService,
	type LoggerService,
	type TelemetryService,
	type WorkerConfig,
	type WorkerContext,
	classifyError,
} from "@lattice/worker-base";
import { Injectable } from "@nestjs/common";
import {
	UpsertRepository,
	type UpsertRepository as UpsertRepositoryType,
} from "../db/upsert.repository.js";
import {
	type ElasticsearchConfig,
	matchAlias,
} from "../elasticsearch/elasticsearch.config.js";
import {
	ElasticsearchService,
	type ElasticsearchService as ElasticsearchServiceType,
} from "../elasticsearch/elasticsearch.service.js";
import type { EsEmailChunkDocument, EsUpsertPayload } from "./worker.types.js";

@Injectable()
export class EsUpserterService extends BaseWorkerService<
	MailEmbedPayload,
	EsUpsertPayload
> {
	constructor(
		kafka: KafkaService,
		telemetry: TelemetryService,
		logger: LoggerService,
		config: WorkerConfig,
		private readonly upsertRepository: UpsertRepositoryType,
		private readonly esService: ElasticsearchServiceType,
		private readonly esConfig: ElasticsearchConfig,
	) {
		super(kafka, telemetry, logger, config);

		if (esConfig.aliasPattern) {
			this.logger.info("Alias filter enabled", {
				pattern: esConfig.aliasPattern,
				stage: "es-upsert",
			});
		} else {
			this.logger.info("Alias filter disabled, processing all emails", {
				stage: "es-upsert",
			});
		}
	}

	protected async process(
		payload: MailEmbedPayload,
		context: WorkerContext,
	): Promise<
		| { status: "success"; output: EsUpsertPayload }
		| { status: "skip"; reason: string }
		| { status: "retry"; reason: string }
		| { status: "dlq"; reason: string; error: Error }
	> {
		const logContext: Record<string, unknown> = {
			email_id: payload.email_id,
			chunk_id: payload.chunk_id,
			chunk_hash: payload.chunk_hash,
			embedding_version: payload.embedding_version,
			stage: "es-upsert",
		};
		if (context.traceId) logContext["trace_id"] = context.traceId;

		this.logger.info(
			"Processing embedding for Elasticsearch upsert",
			logContext,
		);
		this.telemetry.increment("messages.received", 1, { stage: "es-upsert" });

		try {
			// Fetch email metadata from Postgres
			const emailMetadata = await this.upsertRepository.getEmailMetadata(
				payload.email_id,
			);

			if (!emailMetadata) {
				this.logger.warn("Email metadata not found", logContext);
				this.telemetry.increment("messages.error", 1, {
					stage: "es-upsert",
					error_code: "metadata_not_found",
				});
				return {
					status: "dlq",
					reason: "Email metadata not found",
					error: new Error(`Email not found: ${payload.email_id}`),
				};
			}

			// Alias filter — early exit if pattern is set and alias doesn't match
			if (this.esConfig.aliasPattern) {
				const alias = emailMetadata.alias ?? "";
				if (!matchAlias(alias, this.esConfig.aliasPattern)) {
					this.telemetry.increment("messages.skipped", 1, {
						stage: "es-upsert",
						reason: "alias_filtered",
					});
					return {
						status: "skip",
						reason: `Alias "${alias}" does not match pattern "${this.esConfig.aliasPattern}"`,
					};
				}
			}

			// Generate deterministic doc ID for idempotency
			const docId = ElasticsearchService.generateDocId(
				payload.email_id,
				payload.chunk_hash,
				payload.embedding_version,
			);

			// Idempotency check — skip if document already exists
			const exists = await this.esService.documentExists(docId);
			if (exists) {
				this.logger.info("Document already exists in Elasticsearch, skipping", {
					...logContext,
					es_doc_id: docId,
				});
				this.telemetry.increment("messages.skipped", 1, {
					stage: "es-upsert",
					reason: "duplicate",
				});
				return {
					status: "skip",
					reason: "Document already exists in Elasticsearch",
				};
			}

			// Fetch embedding from Postgres
			const embedding = await this.upsertRepository.getEmbeddingWithMetadata(
				payload.email_id,
				payload.chunk_hash,
				payload.embedding_version,
			);

			if (!embedding) {
				this.logger.warn("Embedding not found in database", logContext);
				this.telemetry.increment("messages.error", 1, {
					stage: "es-upsert",
					error_code: "not_found",
				});
				return {
					status: "dlq",
					reason: "Embedding not found in database",
					error: new Error(
						`Embedding not found: ${payload.email_id}/${payload.chunk_hash}/${payload.embedding_version}`,
					),
				};
			}

			// Convert vector buffer to float array
			const vector = UpsertRepository.bufferToVector(embedding.vector_data);

			// Build ES document
			const esDocument: EsEmailChunkDocument = {
				doc_id: docId,
				tenant_id: emailMetadata.tenant_id,
				account_id: emailMetadata.account_id,
				alias: emailMetadata.alias ?? "",
				email_id: payload.email_id,
				chunk_hash: payload.chunk_hash,
				embedding_version: payload.embedding_version,
				embedding_model: embedding.embedding_model,
				section_type: embedding.section_type ?? "",
				email_timestamp: emailMetadata.received_at
					? emailMetadata.received_at.toISOString()
					: null,
				chunk_text: embedding.chunk_text,
				vector,
				indexed_at: new Date().toISOString(),
			};

			// Index to Elasticsearch
			const startIndex = Date.now();
			const result = await this.esService.indexDocument(
				docId,
				esDocument as unknown as Record<string, unknown>,
			);
			this.telemetry.timing(
				"elasticsearch.index.duration_ms",
				Date.now() - startIndex,
				{ stage: "es-upsert" },
			);

			if (!result.success) {
				const errorMsg = result.error ?? "Unknown Elasticsearch error";
				this.logger.error(
					"Elasticsearch index failed",
					errorMsg,
					JSON.stringify(logContext),
				);
				this.telemetry.increment("messages.error", 1, {
					stage: "es-upsert",
					error_code: "es_error",
				});

				if (this.isRetryableError(errorMsg)) {
					return {
						status: "retry",
						reason: `Elasticsearch index failed: ${errorMsg}`,
					};
				}

				return {
					status: "dlq",
					reason: `Elasticsearch index failed: ${errorMsg}`,
					error: new Error(errorMsg),
				};
			}

			// Build output payload
			const outputPayload: EsUpsertPayload = {
				provider_message_id: payload.provider_message_id,
				email_id: payload.email_id,
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_id: payload.embedding_id,
				embedding_version: payload.embedding_version,
				es_index: this.esService.getIndexName(),
				es_doc_id: docId,
				upserted_at: new Date().toISOString(),
				is_update: result.isUpdate,
			};

			this.telemetry.increment("messages.success", 1, {
				stage: "es-upsert",
			});
			this.logger.info("Document indexed to Elasticsearch successfully", {
				...logContext,
				es_doc_id: docId,
				is_update: result.isUpdate,
				es_index: this.esService.getIndexName(),
			});

			return { status: "success", output: outputPayload };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.telemetry.increment("messages.error", 1, { stage: "es-upsert" });

			this.logger.error(
				"Failed to index document",
				err.stack,
				JSON.stringify(logContext),
			);

			const classification = classifyError(err);
			if (
				classification === "retryable" ||
				this.isRetryableError(err.message)
			) {
				return { status: "retry", reason: err.message };
			}

			return { status: "dlq", reason: err.message, error: err };
		}
	}

	/**
	 * Check if error is retryable (network/transient issues)
	 */
	private isRetryableError(message: string): boolean {
		const retryablePatterns = [
			"ECONNREFUSED",
			"ECONNRESET",
			"ETIMEDOUT",
			"ConnectionError",
			"TimeoutError",
			"circuit_breaking_exception",
			"es_rejected_execution_exception",
			"503",
			"429",
			"too many requests",
			"unavailable",
		];

		const lowerMessage = message.toLowerCase();
		return retryablePatterns.some((pattern) =>
			lowerMessage.includes(pattern.toLowerCase()),
		);
	}
}
