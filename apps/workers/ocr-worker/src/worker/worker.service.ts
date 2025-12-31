import type {
	OcrError,
	OcrRequestPayload,
	OcrResultDetails,
	OcrResultPayload,
	OcrStatus,
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
import type { OcrRepository } from "../db/ocr.repository.js";
import type {
	OcrEngineResult,
	TesseractEngine,
} from "../ocr/tesseract.engine.js";
import type { StorageService } from "../storage/storage.service.js";

@Injectable()
export class OcrWorkerService extends BaseWorkerService<
	OcrRequestPayload,
	OcrResultPayload
> {
	constructor(
		kafka: KafkaService,
		telemetry: TelemetryService,
		logger: LoggerService,
		config: WorkerConfig,
		private readonly ocrRepository: OcrRepository,
		private readonly tesseractEngine: TesseractEngine,
		private readonly storageService: StorageService,
	) {
		super(kafka, telemetry, logger, config);
	}

	protected async process(
		payload: OcrRequestPayload,
		context: WorkerContext,
	): Promise<
		| { status: "success"; output: OcrResultPayload }
		| { status: "skip"; reason: string }
		| { status: "retry"; reason: string }
		| { status: "dlq"; reason: string; error: Error }
	> {
		const startTime = Date.now();
		const logContext: Record<string, unknown> = {
			request_id: payload.request_id,
			source_service: payload.source.service,
			correlation_id: payload.source.correlation_id,
			mime_type: payload.content.mime_type,
			stage: "ocr",
		};
		if (context.traceId) logContext["trace_id"] = context.traceId;

		this.logger.info("Processing OCR request", logContext);
		this.telemetry.increment("messages.received", 1, { stage: "ocr" });

		const tenantId = context.envelope?.tenant_id ?? "unknown";
		const accountId = context.envelope?.account_id ?? "unknown";

		try {
			// Idempotency check - skip if already processed
			const existing = await this.ocrRepository.findByRequestId(
				payload.request_id,
			);
			if (existing && existing.status !== "processing") {
				this.logger.info("OCR request already processed (idempotent skip)", {
					...logContext,
					existing_status: existing.status,
				});
				this.telemetry.increment("messages.skipped", 1, {
					stage: "ocr",
					reason: "idempotent",
				});

				// Return the existing result
				// We know status is "success" | "failed" since we checked for "processing" above
				const result: OcrResultPayload = {
					request_id: payload.request_id,
					source: payload.source,
					result: {
						status: existing.status as OcrStatus,
						text_uri: existing.text_uri ?? "",
						text_length: existing.text_length ?? 0,
						page_count: existing.page_count ?? 0,
						processing_time_ms: existing.processing_time_ms ?? 0,
						confidence: existing.confidence,
					},
					completed_at:
						existing.completed_at?.toISOString() ?? new Date().toISOString(),
				};

				if (existing.error_code) {
					result.error = {
						code: existing.error_code,
						message: existing.error_message ?? "Unknown error",
					};
				}

				return { status: "success", output: result };
			}

			// Create or update record to mark processing started
			if (!existing) {
				await this.ocrRepository.createResult({
					requestId: payload.request_id,
					tenantId,
					sourceService: payload.source.service,
					correlationId: payload.source.correlation_id,
					inputUri: payload.content.storage_uri,
					inputMimeType: payload.content.mime_type,
					inputSizeBytes: payload.content.size_bytes,
				});
			}

			// Fetch content from storage
			const startFetch = Date.now();
			const content = await this.storageService.getBytes(
				payload.content.storage_uri,
			);
			this.telemetry.timing("storage.fetch_ms", Date.now() - startFetch, {
				stage: "ocr",
			});

			this.logger.debug("Fetched content from storage", {
				...logContext,
				size_bytes: content.length,
			});

			// Run OCR
			const startOcr = Date.now();
			let ocrResult: OcrEngineResult;
			try {
				ocrResult = await this.tesseractEngine.process(
					content,
					payload.content.mime_type,
					payload.options?.dpi,
				);
			} catch (ocrError) {
				// OCR failed - record error and return failure result
				const error =
					ocrError instanceof Error ? ocrError : new Error(String(ocrError));
				const processingTime = Date.now() - startTime;

				await this.ocrRepository.updateResult(payload.request_id, {
					status: "failed",
					processingTimeMs: processingTime,
					errorCode: "TESSERACT_FAILED",
					errorMessage: error.message,
				});

				const failedResult: OcrResultPayload = {
					request_id: payload.request_id,
					source: payload.source,
					result: {
						status: "failed",
						text_uri: "",
						text_length: 0,
						page_count: 0,
						processing_time_ms: processingTime,
					},
					error: {
						code: "TESSERACT_FAILED",
						message: error.message,
					},
					completed_at: new Date().toISOString(),
				};

				this.telemetry.increment("messages.ocr_failed", 1, { stage: "ocr" });
				this.logger.error(
					"OCR processing failed",
					error.stack,
					JSON.stringify(logContext),
				);

				return { status: "success", output: failedResult };
			}

			this.telemetry.timing("ocr.duration_ms", Date.now() - startOcr, {
				stage: "ocr",
			});

			this.logger.debug("OCR extraction complete", {
				...logContext,
				text_length: ocrResult.text.length,
				page_count: ocrResult.pageCount,
				confidence: ocrResult.confidence,
			});

			// Store extracted text in MinIO
			const startStore = Date.now();
			const textUri = await this.storageService.storeText(
				payload.request_id,
				tenantId,
				ocrResult.text,
			);
			this.telemetry.timing("storage.store_ms", Date.now() - startStore, {
				stage: "ocr",
			});

			const processingTime = Date.now() - startTime;

			// Update database with success
			await this.ocrRepository.updateResult(payload.request_id, {
				status: "success",
				textUri,
				textLength: ocrResult.text.length,
				pageCount: ocrResult.pageCount,
				processingTimeMs: processingTime,
				confidence: ocrResult.confidence,
			});

			// Build result payload
			const resultDetails: OcrResultDetails = {
				status: "success",
				text_uri: textUri,
				text_length: ocrResult.text.length,
				page_count: ocrResult.pageCount,
				processing_time_ms: processingTime,
				confidence: ocrResult.confidence,
			};

			const result: OcrResultPayload = {
				request_id: payload.request_id,
				source: payload.source,
				result: resultDetails,
				completed_at: new Date().toISOString(),
			};

			this.telemetry.increment("messages.success", 1, { stage: "ocr" });
			this.logger.info("OCR processing complete", {
				...logContext,
				text_length: ocrResult.text.length,
				page_count: ocrResult.pageCount,
				processing_time_ms: processingTime,
			});

			return { status: "success", output: result };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.telemetry.increment("messages.error", 1, { stage: "ocr" });

			this.logger.error(
				"Failed to process OCR request",
				err.stack,
				JSON.stringify(logContext),
			);

			const classification = classifyError(err);
			if (classification === "retryable") {
				return { status: "retry", reason: err.message };
			}

			// Record failure in database
			try {
				await this.ocrRepository.updateResult(payload.request_id, {
					status: "failed",
					processingTimeMs: Date.now() - startTime,
					errorCode: "PROCESSING_ERROR",
					errorMessage: err.message,
				});
			} catch (dbError) {
				this.logger.error("Failed to update OCR status", String(dbError));
			}

			return { status: "dlq", reason: err.message, error: err };
		}
	}
}
