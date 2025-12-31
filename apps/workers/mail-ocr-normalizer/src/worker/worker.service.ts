import type {
	AttachmentTextReadyPayload,
	OcrResultPayload,
} from "@lattice/core-contracts";
import { TOPICS } from "@lattice/core-kafka";
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
import type { StorageService } from "../storage/storage.service.js";

/**
 * Mail OCR Normalizer Service
 *
 * This worker bridges the domain-agnostic OCR results back to the mail pipeline.
 * It consumes from lattice.ocr.result.v1 and emits to lattice.mail.attachment.text.v1
 * so the attachment-chunker can process OCR results identically to direct extractions.
 *
 * Only processes results from source.service === "mail-extractor"
 */
@Injectable()
export class MailOcrNormalizerService extends BaseWorkerService<
	OcrResultPayload,
	AttachmentTextReadyPayload
> {
	constructor(
		kafka: KafkaService,
		telemetry: TelemetryService,
		logger: LoggerService,
		config: WorkerConfig,
		private readonly storageService: StorageService,
	) {
		super(kafka, telemetry, logger, config);
	}

	protected async process(
		payload: OcrResultPayload,
		context: WorkerContext,
	): Promise<
		| { status: "success"; output: AttachmentTextReadyPayload }
		| { status: "skip"; reason: string }
		| { status: "retry"; reason: string }
		| { status: "dlq"; reason: string; error: Error }
	> {
		const logContext: Record<string, unknown> = {
			request_id: payload.request_id,
			source_service: payload.source.service,
			correlation_id: payload.source.correlation_id,
			ocr_status: payload.result.status,
			stage: "ocr-normalizer",
		};
		if (context.traceId) logContext["trace_id"] = context.traceId;

		this.logger.info(
			"Processing OCR result for mail normalization",
			logContext,
		);
		this.telemetry.increment("messages.received", 1, {
			stage: "ocr-normalizer",
		});

		// Only process results from mail-extractor
		if (payload.source.service !== "mail-extractor") {
			this.logger.debug("Skipping non-mail OCR result", {
				...logContext,
				reason: "source_not_mail_extractor",
			});
			this.telemetry.increment("messages.skipped", 1, {
				stage: "ocr-normalizer",
				reason: "wrong_source",
			});
			return {
				status: "skip",
				reason: `Skipping result from ${payload.source.service} - only processing mail-extractor results`,
			};
		}

		// Skip failed OCR results
		if (payload.result.status === "failed") {
			this.logger.info("OCR processing failed, skipping normalization", {
				...logContext,
				error_code: payload.error?.code,
				error_message: payload.error?.message,
			});
			this.telemetry.increment("messages.skipped", 1, {
				stage: "ocr-normalizer",
				reason: "ocr_failed",
			});
			return {
				status: "skip",
				reason: `OCR failed: ${payload.error?.message ?? "unknown error"}`,
			};
		}

		// Parse correlation_id: format is "{email_id}:{attachment_id}"
		const [emailId, attachmentId] = payload.source.correlation_id.split(":");
		if (!emailId || !attachmentId) {
			this.logger.error(
				"Invalid correlation_id format",
				undefined,
				JSON.stringify({
					...logContext,
					correlation_id: payload.source.correlation_id,
				}),
			);
			return {
				status: "dlq",
				reason: `Invalid correlation_id format: ${payload.source.correlation_id}`,
				error: new Error(
					`Expected format 'email_id:attachment_id', got '${payload.source.correlation_id}'`,
				),
			};
		}

		try {
			// Fetch the OCR text from MinIO
			const startFetch = Date.now();
			const ocrText = await this.storageService.getText(
				payload.result.text_uri,
			);
			this.telemetry.timing("storage.fetch_ms", Date.now() - startFetch, {
				stage: "ocr-normalizer",
			});

			this.logger.debug("Fetched OCR text from storage", {
				...logContext,
				text_length: ocrText.length,
				text_uri: payload.result.text_uri,
			});

			// Build the AttachmentTextReadyPayload
			const textReadyPayload: AttachmentTextReadyPayload = {
				email_id: emailId,
				attachment_id: attachmentId,
				text_source: "ocr",
				text_length: ocrText.length,
				mime_type: "text/plain", // OCR output is always text
				text_quality: {
					confidence: payload.result.confidence
						? payload.result.confidence / 100
						: undefined,
					source_model: "tesseract",
				},
				ocr_request_id: payload.request_id,
				ready_at: new Date().toISOString(),
			};

			// Get tenant/account from context for message routing
			const tenantId = context.envelope?.tenant_id ?? "unknown";
			const accountId = context.envelope?.account_id ?? "unknown";

			// Emit to the mail attachment text topic
			await this.kafka.produce(TOPICS.MAIL_ATTACHMENT_TEXT, textReadyPayload, {
				tenantId,
				accountId,
				domain: "mail",
				stage: "ocr-normalize",
				schemaVersion: "v1",
			});

			this.logger.info("Emitted attachment text ready event from OCR", {
				...logContext,
				email_id: emailId,
				attachment_id: attachmentId,
				text_length: ocrText.length,
			});

			this.telemetry.increment("messages.success", 1, {
				stage: "ocr-normalizer",
			});
			this.telemetry.increment("messages.text_ready_emitted", 1, {
				stage: "ocr-normalizer",
				text_source: "ocr",
			});

			return { status: "success", output: textReadyPayload };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.telemetry.increment("messages.error", 1, {
				stage: "ocr-normalizer",
			});

			this.logger.error(
				"Failed to normalize OCR result",
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
