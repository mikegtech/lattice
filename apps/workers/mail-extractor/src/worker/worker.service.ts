import type {
	AttachmentExtractRequest,
	AttachmentExtractResult,
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
import type { AttachmentRepository } from "../db/attachment.repository.js";
import type { ExtractionService } from "../extraction/extraction.service.js";
import type { StorageService } from "../storage/storage.service.js";

@Injectable()
export class MailExtractorService extends BaseWorkerService<
	AttachmentExtractRequest,
	AttachmentExtractResult
> {
	constructor(
		kafka: KafkaService,
		telemetry: TelemetryService,
		logger: LoggerService,
		config: WorkerConfig,
		private readonly attachmentRepository: AttachmentRepository,
		private readonly extractionService: ExtractionService,
		private readonly storageService: StorageService,
	) {
		super(kafka, telemetry, logger, config);
	}

	protected async process(
		payload: AttachmentExtractRequest,
		context: WorkerContext,
	): Promise<
		| { status: "success"; output: AttachmentExtractResult }
		| { status: "skip"; reason: string }
		| { status: "retry"; reason: string }
		| { status: "dlq"; reason: string; error: Error }
	> {
		const logContext: Record<string, unknown> = {
			email_id: payload.email_id,
			attachment_id: payload.attachment_id,
			mime_type: payload.mime_type,
			stage: "extract",
		};
		if (context.traceId) logContext["trace_id"] = context.traceId;

		this.logger.info("Processing attachment extraction", logContext);
		this.telemetry.increment("messages.received", 1, { stage: "extract" });

		try {
			// Check if MIME type is supported
			if (!this.extractionService.isSupported(payload.mime_type)) {
				this.logger.info("Unsupported MIME type, skipping extraction", {
					...logContext,
					reason: "unsupported_mime_type",
				});

				// Update database with unsupported status
				await this.attachmentRepository.updateExtractedText(
					payload.email_id,
					payload.attachment_id,
					null,
					"unsupported",
					`Unsupported MIME type: ${payload.mime_type}`,
				);

				const result: AttachmentExtractResult = {
					email_id: payload.email_id,
					attachment_id: payload.attachment_id,
					extraction_status: "unsupported",
					extracted_text_length: 0,
					extraction_error: `Unsupported MIME type: ${payload.mime_type}`,
					extracted_at: new Date().toISOString(),
				};

				this.telemetry.increment("messages.skipped", 1, {
					stage: "extract",
					reason: "unsupported_mime_type",
				});

				return { status: "success", output: result };
			}

			// Fetch attachment from storage
			const startFetch = Date.now();
			const content = await this.storageService.getBytes(payload.storage_uri);
			this.telemetry.timing("storage.fetch_ms", Date.now() - startFetch, {
				stage: "extract",
			});

			this.logger.debug("Fetched attachment from storage", {
				...logContext,
				size_bytes: content.length,
			});

			// Extract text
			const startExtract = Date.now();
			const extractionResult = await this.extractionService.extract(
				content,
				payload.mime_type,
			);
			this.telemetry.timing(
				"extraction.duration_ms",
				Date.now() - startExtract,
				{
					stage: "extract",
					mime_type: payload.mime_type,
				},
			);

			// Map extraction status to contract-compatible status
			// The contract only supports "success" | "failed" | "unsupported"
			// We map "needs_ocr" to "failed" with a descriptive error for now
			const contractStatus: "success" | "failed" | "unsupported" =
				extractionResult.status === "needs_ocr"
					? "failed"
					: extractionResult.status;

			// Build error message for needs_ocr cases
			const errorMessage =
				extractionResult.status === "needs_ocr"
					? `OCR required: ${extractionResult.ocr_reason ?? "unknown reason"}`
					: extractionResult.error;

			// Update database
			const startDb = Date.now();
			await this.attachmentRepository.updateExtractedText(
				payload.email_id,
				payload.attachment_id,
				extractionResult.status === "success" ? extractionResult.text : null,
				contractStatus,
				errorMessage,
			);
			this.telemetry.timing("db.update_ms", Date.now() - startDb, {
				stage: "extract",
			});

			// Track OCR routing signal in telemetry
			if (extractionResult.needs_ocr) {
				this.telemetry.increment("extraction.needs_ocr", 1, {
					stage: "extract",
					ocr_reason: extractionResult.ocr_reason ?? "unknown",
				});
			}

			// Build result
			const result: AttachmentExtractResult = {
				email_id: payload.email_id,
				attachment_id: payload.attachment_id,
				extraction_status: contractStatus,
				extracted_text_length: extractionResult.text.length,
				extracted_at: new Date().toISOString(),
			};

			if (errorMessage) {
				result.extraction_error = errorMessage;
			}

			this.telemetry.increment("messages.success", 1, {
				stage: "extract",
				extraction_status: extractionResult.status,
			});

			this.logger.info("Attachment extraction complete", {
				...logContext,
				extraction_status: extractionResult.status,
				contract_status: contractStatus,
				text_length: extractionResult.text.length,
				needs_ocr: extractionResult.needs_ocr,
				ocr_reason: extractionResult.ocr_reason,
			});

			return { status: "success", output: result };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.telemetry.increment("messages.error", 1, { stage: "extract" });

			this.logger.error(
				"Failed to extract attachment",
				err.stack,
				JSON.stringify(logContext),
			);

			const classification = classifyError(err);
			if (classification === "retryable") {
				return { status: "retry", reason: err.message };
			}

			// For non-retryable errors, update database and continue
			try {
				await this.attachmentRepository.updateExtractedText(
					payload.email_id,
					payload.attachment_id,
					null,
					"failed",
					err.message,
				);
			} catch (dbError) {
				this.logger.error(
					"Failed to update extraction status",
					String(dbError),
				);
			}

			return { status: "dlq", reason: err.message, error: err };
		}
	}
}
