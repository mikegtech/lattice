import type {
	MailEmbedPayload,
	MailUpsertPayload,
} from "@lattice/core-contracts";
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
import type { MilvusConfig } from "../milvus/milvus.config.js";
import {
	MilvusService,
	type MilvusService as MilvusServiceType,
	type VectorRecord,
} from "../milvus/milvus.service.js";

@Injectable()
export class MailUpserterService extends BaseWorkerService<
	MailEmbedPayload,
	MailUpsertPayload
> {
	constructor(
		kafka: KafkaService,
		telemetry: TelemetryService,
		logger: LoggerService,
		config: WorkerConfig,
		private readonly upsertRepository: UpsertRepositoryType,
		private readonly milvusService: MilvusServiceType,
		private readonly milvusConfig: MilvusConfig,
	) {
		super(kafka, telemetry, logger, config);
	}

	protected async process(
		payload: MailEmbedPayload,
		context: WorkerContext,
	): Promise<
		| { status: "success"; output: MailUpsertPayload }
		| { status: "skip"; reason: string }
		| { status: "retry"; reason: string }
		| { status: "dlq"; reason: string; error: Error }
	> {
		const logContext: Record<string, unknown> = {
			email_id: payload.email_id,
			chunk_id: payload.chunk_id,
			chunk_hash: payload.chunk_hash,
			embedding_version: payload.embedding_version,
			stage: "upsert",
		};
		if (context.traceId) logContext["trace_id"] = context.traceId;

		this.logger.info("Processing embedding for Milvus upsert", logContext);
		this.telemetry.increment("messages.received", 1, { stage: "upsert" });

		try {
			// Generate deterministic PK for idempotency
			const vectorPK = MilvusService.generatePK(
				payload.email_id,
				payload.chunk_hash,
				payload.embedding_version,
			);

			// Check if already upserted (idempotency via Postgres tracking)
			const alreadyUpserted = await this.upsertRepository.vectorExists(
				payload.email_id,
				payload.chunk_hash,
				payload.embedding_version,
			);

			if (alreadyUpserted) {
				this.logger.info(
					"Vector already exists in Milvus for this version, skipping",
					{
						...logContext,
						vector_pk: vectorPK,
					},
				);
				this.telemetry.increment("messages.skipped", 1, {
					stage: "upsert",
					reason: "duplicate",
				});
				return {
					status: "skip",
					reason: "Vector already exists for this version",
				};
			}

			// Fetch embedding vector from Postgres (system of record)
			const embedding = await this.upsertRepository.getEmbeddingWithMetadata(
				payload.email_id,
				payload.chunk_hash,
				payload.embedding_version,
			);

			if (!embedding) {
				this.logger.warn("Embedding not found in database", logContext);
				this.telemetry.increment("messages.error", 1, {
					stage: "upsert",
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

			// Validate dimensions
			const vector = UpsertRepository.bufferToVector(embedding.vector_data);
			if (vector.length !== this.milvusConfig.dimension) {
				this.logger.error(
					"Dimension mismatch",
					`Expected ${this.milvusConfig.dimension}, got ${vector.length}`,
					JSON.stringify(logContext),
				);
				this.telemetry.increment("messages.error", 1, {
					stage: "upsert",
					error_code: "dimension_mismatch",
				});
				return {
					status: "dlq",
					reason: `Dimension mismatch: expected ${this.milvusConfig.dimension}, got ${vector.length}`,
					error: new Error(
						`Dimension mismatch: expected ${this.milvusConfig.dimension}, got ${vector.length}`,
					),
				};
			}

			// Get email metadata for tenant/account info
			const emailMetadata = await this.upsertRepository.getEmailMetadata(
				payload.email_id,
			);

			if (!emailMetadata) {
				this.logger.warn("Email metadata not found", logContext);
				this.telemetry.increment("messages.error", 1, {
					stage: "upsert",
					error_code: "metadata_not_found",
				});
				return {
					status: "dlq",
					reason: "Email metadata not found",
					error: new Error(`Email not found: ${payload.email_id}`),
				};
			}

			// Prepare vector record for Milvus
			const vectorRecord: VectorRecord = {
				pk: vectorPK,
				tenantId: emailMetadata.tenant_id,
				accountId: emailMetadata.account_id,
				alias: emailMetadata.alias ?? undefined,
				emailId: payload.email_id,
				chunkHash: payload.chunk_hash,
				embeddingVersion: payload.embedding_version,
				embeddingModel: payload.embedding_model,
				sectionType: embedding.section_type ?? undefined,
				emailTimestamp: emailMetadata.received_at
					? Math.floor(emailMetadata.received_at.getTime() / 1000)
					: undefined,
				vector,
			};

			// Upsert to Milvus
			const startUpsert = Date.now();
			const results = await this.milvusService.upsert([vectorRecord]);
			this.telemetry.timing(
				"milvus.upsert.duration_ms",
				Date.now() - startUpsert,
				{
					stage: "upsert",
				},
			);

			const result = results[0];
			if (!result || !result.success) {
				const errorMsg = result?.error ?? "Unknown Milvus error";
				this.logger.error(
					"Milvus upsert failed",
					errorMsg,
					JSON.stringify(logContext),
				);
				this.telemetry.increment("messages.error", 1, {
					stage: "upsert",
					error_code: "milvus_error",
				});

				// Classify as retryable (network/transient) or not
				if (this.isRetryableError(errorMsg)) {
					return {
						status: "retry",
						reason: `Milvus upsert failed: ${errorMsg}`,
					};
				}

				return {
					status: "dlq",
					reason: `Milvus upsert failed: ${errorMsg}`,
					error: new Error(errorMsg),
				};
			}

			// Update Postgres with vector_id for traceability
			await this.upsertRepository.updateVectorId(
				payload.chunk_id,
				vectorPK,
				payload.embedding_version,
			);

			// Build output payload
			const upsertedAt = new Date();
			const outputPayload: MailUpsertPayload = {
				provider_message_id: payload.provider_message_id,
				email_id: payload.email_id,
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_id: payload.embedding_id,
				embedding_version: payload.embedding_version,
				milvus_collection: this.milvusConfig.collection,
				vector_id: vectorPK,
				upserted_at: upsertedAt.toISOString(),
				is_update: result.isUpdate,
			};

			this.telemetry.increment("messages.success", 1, { stage: "upsert" });
			this.logger.info("Vector upserted to Milvus successfully", {
				...logContext,
				vector_pk: vectorPK,
				is_update: result.isUpdate,
				collection: this.milvusConfig.collection,
			});

			return { status: "success", output: outputPayload };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.telemetry.increment("messages.error", 1, { stage: "upsert" });

			this.logger.error(
				"Failed to upsert vector",
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
			"ETIMEDOUT",
			"ENOTFOUND",
			"timeout",
			"connection",
			"unavailable",
			"too many requests",
			"rate limit",
		];

		const lowerMessage = message.toLowerCase();
		return retryablePatterns.some((pattern) =>
			lowerMessage.includes(pattern.toLowerCase()),
		);
	}
}
