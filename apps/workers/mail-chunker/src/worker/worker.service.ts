import type {
	MailChunkPayload,
	MailParsePayload,
} from "@lattice/core-contracts";
import {
	BaseWorkerService,
	type KafkaService,
	LOGGER,
	type LoggerService,
	type TelemetryService,
	WORKER_CONFIG,
	type WorkerConfig,
	type WorkerContext,
	classifyError,
} from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import type { ChunkingConfig } from "../chunking/chunking.config.js";
import type {
	ChunkingService,
	GeneratedChunk,
} from "../chunking/chunking.service.js";
import type { ChunkRepository } from "../db/chunk.repository.js";

@Injectable()
export class MailChunkerService extends BaseWorkerService<
	MailParsePayload,
	MailChunkPayload[]
> {
	constructor(
		kafka: KafkaService,
		telemetry: TelemetryService,
		@Inject(LOGGER) logger: LoggerService,
		@Inject(WORKER_CONFIG) config: WorkerConfig,
		private readonly chunkRepository: ChunkRepository,
		private readonly chunkingService: ChunkingService,
		private readonly chunkingConfig: ChunkingConfig,
	) {
		super(kafka, telemetry, logger, config);
	}

	protected async process(
		payload: MailParsePayload,
		context: WorkerContext,
	): Promise<
		| { status: "success"; output: MailChunkPayload[] }
		| { status: "skip"; reason: string }
		| { status: "retry"; reason: string }
		| { status: "dlq"; reason: string; error: Error }
	> {
		const logContext = {
			email_id: payload.email_id,
			trace_id: context.traceId,
			stage: "chunk",
		};

		this.logger.info("Processing parsed email for chunking", logContext);
		this.telemetry.increment("messages.received", 1, { stage: "chunk" });

		try {
			const { chunkingVersion, normalizationVersion } = this.chunkingConfig;

			// Idempotency check: do chunks already exist for this email+versions?
			const chunksExist = await this.chunkRepository.chunksExist(
				payload.email_id,
				chunkingVersion,
				normalizationVersion,
			);

			if (chunksExist) {
				this.logger.info(
					"Chunks already exist for this email and version, skipping",
					{
						...logContext,
						chunking_version: chunkingVersion,
						normalization_version: normalizationVersion,
					},
				);
				this.telemetry.increment("messages.skipped", 1, {
					stage: "chunk",
					reason: "duplicate",
				});
				return {
					status: "skip",
					reason: "Chunks already exist for this version",
				};
			}

			// Fetch content from Postgres for canonical source
			const emailContent = await this.chunkRepository.getEmailContent(
				payload.email_id,
			);

			if (!emailContent) {
				this.logger.warn("Email not found in database", logContext);
				this.telemetry.increment("messages.error", 1, {
					stage: "chunk",
					error: "not_found",
				});
				return {
					status: "dlq",
					reason: "Email not found in database",
					error: new Error(`Email ${payload.email_id} not found`),
				};
			}

			// Fetch attachment extracted text if available
			const attachmentContents =
				await this.chunkRepository.getAttachmentContents(payload.email_id);

			// Chunk the content
			const startChunk = Date.now();
			const chunks = this.chunkingService.chunkEmail({
				emailId: payload.email_id,
				contentHash: payload.content_hash,
				textNormalized:
					emailContent.text_normalized ?? payload.body.text_normalized ?? "",
				subject: payload.headers.subject,
				attachments: attachmentContents.map((a) => ({
					attachmentId: a.attachment_id,
					extractedText: a.extracted_text ?? "",
				})),
			});
			this.telemetry.timing("chunking_time_ms", Date.now() - startChunk, {
				stage: "chunk",
			});

			if (chunks.length === 0) {
				this.logger.info("No chunks generated (empty content)", logContext);
				this.telemetry.increment("messages.skipped", 1, {
					stage: "chunk",
					reason: "empty",
				});
				return { status: "skip", reason: "No content to chunk" };
			}

			// Persist chunks to Postgres
			const startDb = Date.now();
			await this.chunkRepository.insertChunks(
				chunks.map((c) => ({
					email_id: payload.email_id,
					attachment_id: c.attachmentId,
					chunk_id: c.chunkId,
					chunk_hash: c.chunkHash,
					chunk_index: c.chunkIndex,
					total_chunks: c.totalChunks,
					chunk_text: c.chunkText,
					char_count: c.charCount,
					token_count_estimate: c.tokenCountEstimate,
					source_type: c.sourceType,
					section_type: c.sectionType,
					chunking_version: c.chunkingVersion,
					normalization_version: c.normalizationVersion,
				})),
			);
			this.telemetry.timing("db.insert_ms", Date.now() - startDb, {
				stage: "chunk",
			});

			// Build output payloads
			const outputPayloads = this.buildOutputPayloads(payload, chunks);

			this.telemetry.increment("messages.success", 1, { stage: "chunk" });
			this.telemetry.increment("chunks.created", chunks.length, {
				stage: "chunk",
			});
			this.logger.info("Email chunked successfully", {
				...logContext,
				chunk_count: chunks.length,
				chunking_version: chunkingVersion,
				normalization_version: normalizationVersion,
			});

			return { status: "success", output: outputPayloads };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.telemetry.increment("messages.error", 1, { stage: "chunk" });

			this.logger.error(
				"Failed to chunk email",
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

	/**
	 * Build output payloads for each chunk
	 */
	private buildOutputPayloads(
		input: MailParsePayload,
		chunks: GeneratedChunk[],
	): MailChunkPayload[] {
		return chunks.map((chunk) => ({
			provider_message_id: input.provider_message_id,
			email_id: input.email_id,
			content_hash: input.content_hash,
			chunk_id: chunk.chunkId,
			chunk_hash: chunk.chunkHash,
			chunk_index: chunk.chunkIndex,
			total_chunks: chunk.totalChunks,
			chunk_text: chunk.chunkText,
			char_count: chunk.charCount,
			token_count_estimate: chunk.tokenCountEstimate,
			source_type: chunk.sourceType,
			attachment_id: chunk.attachmentId,
			section_type: chunk.sectionType,
			chunking_version: chunk.chunkingVersion,
			normalization_version: chunk.normalizationVersion,
			chunked_at: new Date().toISOString(),
		}));
	}

	/**
	 * Override to produce multiple output messages (one per chunk)
	 */
	protected override async produceOutput(
		output: MailChunkPayload[],
		originalMessage: {
			envelope: { tenant_id: string; account_id: string; domain: string };
		},
	): Promise<void> {
		const topicOut = this.config.kafka.topicOut;
		if (!topicOut || output.length === 0) {
			return;
		}

		// Produce each chunk as a separate message
		for (const chunkPayload of output) {
			await this.kafka.produce(topicOut, chunkPayload, {
				tenantId: originalMessage.envelope.tenant_id,
				accountId: originalMessage.envelope.account_id,
				domain: originalMessage.envelope.domain as
					| "mail"
					| "calendar"
					| "drive"
					| "contacts",
				stage: this.config.stage,
				schemaVersion: "v1",
			});
		}
	}
}
