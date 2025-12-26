import type {
	MailChunkPayload,
	MailEmbedPayload,
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
import { v4 as uuidv4 } from "uuid";
import {
	EmbeddingRepository,
	type EmbeddingRepository as EmbeddingRepositoryType,
} from "../db/embedding.repository.js";
import type { EmbeddingConfig } from "../embedding/embedding.config.js";
import type { EmbeddingService } from "../embedding/embedding.service.js";

@Injectable()
export class MailEmbedderService extends BaseWorkerService<
	MailChunkPayload,
	MailEmbedPayload
> {
	constructor(
		kafka: KafkaService,
		telemetry: TelemetryService,
		logger: LoggerService,
		config: WorkerConfig,
		private readonly embeddingRepository: EmbeddingRepositoryType,
		private readonly embeddingService: EmbeddingService,
		private readonly embeddingConfig: EmbeddingConfig,
	) {
		super(kafka, telemetry, logger, config);
	}

	protected async process(
		payload: MailChunkPayload,
		context: WorkerContext,
	): Promise<
		| { status: "success"; output: MailEmbedPayload }
		| { status: "skip"; reason: string }
		| { status: "retry"; reason: string }
		| { status: "dlq"; reason: string; error: Error }
	> {
		const logContext: Record<string, unknown> = {
			email_id: payload.email_id,
			chunk_id: payload.chunk_id,
			chunk_hash: payload.chunk_hash,
			stage: "embed",
		};
		if (context.traceId) logContext["trace_id"] = context.traceId;

		this.logger.info("Processing chunk for embedding", logContext);
		this.telemetry.increment("messages.received", 1, { stage: "embed" });

		try {
			const embeddingVersion = this.embeddingService.embeddingVersion;

			// Idempotency check: do not re-embed same (email_id, chunk_hash, embedding_version)
			const exists = await this.embeddingRepository.embeddingExists(
				payload.email_id,
				payload.chunk_hash,
				embeddingVersion,
			);

			if (exists) {
				this.logger.info(
					"Embedding already exists for this chunk and version, skipping",
					{
						...logContext,
						embedding_version: embeddingVersion,
					},
				);
				this.telemetry.increment("messages.skipped", 1, {
					stage: "embed",
					reason: "duplicate",
				});
				return {
					status: "skip",
					reason: "Embedding already exists for this version",
				};
			}

			// Fetch chunk_text from Postgres (system of record)
			const chunkContent = await this.embeddingRepository.getChunkContent(
				payload.chunk_id,
			);

			if (!chunkContent) {
				this.logger.warn("Chunk not found in database", logContext);
				this.telemetry.increment("messages.error", 1, {
					stage: "embed",
					error_code: "not_found",
				});
				return {
					status: "dlq",
					reason: "Chunk not found in database",
					error: new Error(`Chunk ${payload.chunk_id} not found`),
				};
			}

			// Generate embedding
			const startEmbed = Date.now();
			const embeddingResponse = await this.embeddingService.embedSingle({
				chunkId: payload.chunk_id,
				chunkHash: payload.chunk_hash,
				text: chunkContent.chunk_text,
			});
			this.telemetry.timing("embedding_time_ms", Date.now() - startEmbed, {
				stage: "embed",
			});

			if (embeddingResponse.error) {
				this.logger.error(
					"Embedding generation failed",
					embeddingResponse.error,
					JSON.stringify(logContext),
				);
				this.telemetry.increment("messages.error", 1, {
					stage: "embed",
					error_code: "embed_failed",
				});
				return {
					status: "retry",
					reason: `Embedding failed: ${embeddingResponse.error}`,
				};
			}

			// Generate embedding ID
			const embeddingId = uuidv4();
			const embeddedAt = new Date();

			// Persist embedding to Postgres
			const startDb = Date.now();
			await this.embeddingRepository.insertEmbedding({
				embedding_id: embeddingId,
				email_id: payload.email_id,
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_model: embeddingResponse.model,
				embedding_version: embeddingVersion,
				vector_dim: embeddingResponse.dimensions,
				vector_data: EmbeddingRepository.vectorToBuffer(
					embeddingResponse.vector,
				),
				embedded_at: embeddedAt,
			});
			this.telemetry.timing("db.insert_ms", Date.now() - startDb, {
				stage: "embed",
			});

			// Build output payload (no vector - stored in Postgres)
			const outputPayload: MailEmbedPayload = {
				provider_message_id: payload.provider_message_id,
				email_id: payload.email_id,
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_id: embeddingId,
				embedding_version: embeddingVersion,
				embedding_model: embeddingResponse.model,
				embedding_dimensions: embeddingResponse.dimensions,
				vector_storage: "postgres",
				embedded_at: embeddedAt.toISOString(),
			};

			this.telemetry.increment("messages.success", 1, { stage: "embed" });
			this.logger.info("Chunk embedded successfully", {
				...logContext,
				embedding_id: embeddingId,
				embedding_version: embeddingVersion,
				dimensions: embeddingResponse.dimensions,
			});

			return { status: "success", output: outputPayload };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.telemetry.increment("messages.error", 1, { stage: "embed" });

			this.logger.error(
				"Failed to embed chunk",
				err.stack,
				JSON.stringify(logContext),
			);

			const classification = classifyError(err);
			if (classification === "retryable") {
				return { status: "retry", reason: err.message };
			}

			return { status: "dlq", reason: err.message, error: err };
		}
	}
}
