import type {
	AttachmentTextReadyPayload,
	MailChunkPayload,
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
import type { ChunkingService } from "../chunking/chunking.service.js";
import type { AttachmentRepository } from "../db/attachment.repository.js";

@Injectable()
export class AttachmentChunkerService extends BaseWorkerService<
	AttachmentTextReadyPayload,
	MailChunkPayload
> {
	constructor(
		kafka: KafkaService,
		telemetry: TelemetryService,
		logger: LoggerService,
		config: WorkerConfig,
		private readonly attachmentRepository: AttachmentRepository,
		private readonly chunkingService: ChunkingService,
	) {
		super(kafka, telemetry, logger, config);
	}

	protected async process(
		payload: AttachmentTextReadyPayload,
		context: WorkerContext,
	): Promise<
		| { status: "success"; output?: MailChunkPayload }
		| { status: "skip"; reason: string }
		| { status: "retry"; reason: string }
		| { status: "dlq"; reason: string; error: Error }
	> {
		const logContext: Record<string, unknown> = {
			email_id: payload.email_id,
			attachment_id: payload.attachment_id,
			text_source: payload.text_source,
			text_length: payload.text_length,
			stage: "chunk",
		};
		if (context.traceId) logContext["trace_id"] = context.traceId;

		this.logger.info("Processing attachment text for chunking", logContext);
		this.telemetry.increment("messages.received", 1, {
			stage: "chunk",
			source_type: "attachment",
			text_source: payload.text_source,
		});

		// Skip if no text
		if (!payload.text_length || payload.text_length === 0) {
			this.logger.info("Skipping empty text", logContext);
			this.telemetry.increment("messages.skipped", 1, {
				stage: "chunk",
				reason: "empty_text",
			});
			return { status: "skip", reason: "No text to chunk" };
		}

		try {
			// Fetch the actual extracted text from Postgres
			const attachment = await this.attachmentRepository.getExtractedText(
				payload.email_id,
				payload.attachment_id,
			);

			if (!attachment || !attachment.extracted_text) {
				this.logger.warn("Extracted text not found in database", logContext);
				this.telemetry.increment("messages.skipped", 1, {
					stage: "chunk",
					reason: "text_not_in_db",
				});
				return { status: "skip", reason: "Extracted text not in database" };
			}

			// Get email metadata for chunk context
			const emailMeta = await this.attachmentRepository.getEmailMetadata(
				payload.email_id,
			);

			if (!emailMeta) {
				return {
					status: "dlq",
					reason: "Email not found",
					error: new Error(`Email ${payload.email_id} not found`),
				};
			}

			// Chunk the extracted text
			const chunks = this.chunkingService.chunkText(attachment.extracted_text, {
				emailId: payload.email_id,
				contentHash: emailMeta.content_hash,
				attachmentId: payload.attachment_id,
			});

			if (chunks.length === 0) {
				this.logger.info("No chunks created (text too short)", {
					...logContext,
					text_length: attachment.extracted_text.length,
				});
				this.telemetry.increment("messages.skipped", 1, {
					stage: "chunk",
					reason: "text_too_short",
				});
				return { status: "skip", reason: "Text too short to chunk" };
			}

			this.logger.info("Created attachment chunks", {
				...logContext,
				chunk_count: chunks.length,
				text_length: attachment.extracted_text.length,
			});

			// Get output topic
			const outputTopic = this.config.kafka.topicOut;
			if (!outputTopic) {
				return {
					status: "dlq",
					reason: "KAFKA_TOPIC_OUT not configured",
					error: new Error("KAFKA_TOPIC_OUT not configured"),
				};
			}

			// Emit each chunk
			for (const chunk of chunks) {
				const chunkPayload: MailChunkPayload = {
					provider_message_id: emailMeta.provider_message_id,
					email_id: payload.email_id,
					content_hash: emailMeta.content_hash,
					chunk_id: chunk.chunkId,
					chunk_hash: chunk.chunkHash,
					chunk_index: chunk.chunkIndex,
					total_chunks: chunk.totalChunks,
					chunk_text: chunk.chunkText,
					char_count: chunk.charCount,
					token_count_estimate: chunk.tokenCountEstimate,
					source_type: "attachment",
					attachment_id: payload.attachment_id,
					section_type: "attachment_text",
					chunking_version: chunk.chunkingVersion,
					normalization_version: chunk.normalizationVersion,
					chunked_at: new Date().toISOString(),
				};

				await this.kafka.produce(outputTopic, chunkPayload, {
					tenantId: context.envelope?.tenant_id ?? "default",
					accountId: context.envelope?.account_id ?? emailMeta.account_id,
					domain: "mail",
					stage: "chunk",
					schemaVersion: "v1",
				});
			}

			this.telemetry.increment("chunks.created", chunks.length, {
				stage: "chunk",
				source_type: "attachment",
				text_source: payload.text_source,
			});
			this.telemetry.increment("messages.success", 1, {
				stage: "chunk",
				source_type: "attachment",
				text_source: payload.text_source,
			});

			// Return success (no single output - we produced multiple chunks)
			return { status: "success" };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.telemetry.increment("messages.error", 1, {
				stage: "chunk",
				source_type: "attachment",
				text_source: payload.text_source,
			});

			this.logger.error(
				"Failed to chunk attachment",
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
