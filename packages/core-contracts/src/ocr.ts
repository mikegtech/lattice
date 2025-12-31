/**
 * OCR request/result contracts - domain-agnostic OCR processing
 *
 * Design principles:
 * - OCR text is stored in MinIO (not inline in Kafka messages)
 * - Metadata is stored in Postgres for idempotency
 * - Results reference text via URI (claim-check pattern)
 */

/**
 * Reasons why OCR processing is needed
 */
export type OcrReason =
	| "image_attachment"
	| "pdf_no_text"
	| "pdf_low_quality_text"
	| "unsupported_format";

/**
 * OCR processing status (final states for Kafka messages)
 */
export type OcrStatus = "success" | "failed";

/**
 * OCR database status (includes intermediate "processing" state)
 */
export type OcrDbStatus = "processing" | "success" | "failed";

/**
 * OCR engine type
 */
export type OcrEngine = "tesseract";

// ─────────────────────────────────────────────────────────────
// REQUEST (Input to ocr-worker)
// ─────────────────────────────────────────────────────────────

/**
 * Source information for OCR request routing
 */
export interface OcrSource {
	/** Requesting service name (e.g., "mail-extractor") */
	service: string;
	/** Correlation ID for matching results (e.g., "{email_id}:{attachment_id}") */
	correlation_id: string;
}

/**
 * Content information for OCR processing
 */
export interface OcrContent {
	/** URI in MinIO/S3 */
	storage_uri: string;
	/** MIME type of the content */
	mime_type: string;
	/** Original filename (for logging) */
	filename?: string;
	/** File size in bytes */
	size_bytes?: number;
}

/**
 * OCR processing options
 */
export interface OcrOptions {
	/** Engine: only "tesseract" supported for now */
	engine?: OcrEngine;
	/** DPI for PDF rendering (default: 300) */
	dpi?: number;
	/** Page range for multi-page docs (e.g., "1-5") */
	page_range?: string;
}

/**
 * OCR request payload - emitted to lattice.ocr.request.v1
 */
export interface OcrRequestPayload {
	/** Unique request ID for idempotency */
	request_id: string;

	/** Source of the request (for routing results) */
	source: OcrSource;

	/** Content location in object storage */
	content: OcrContent;

	/** Why OCR is needed */
	ocr_reason: OcrReason;

	/** OCR configuration */
	options?: OcrOptions;

	/** When this request was created */
	created_at: string;
}

// ─────────────────────────────────────────────────────────────
// RESULT (Output from ocr-worker)
// ─────────────────────────────────────────────────────────────

/**
 * OCR extraction result details
 */
export interface OcrResultDetails {
	/** Processing status */
	status: OcrStatus;

	/** URI to extracted text in MinIO (empty if failed) */
	text_uri: string;

	/** Text length in characters */
	text_length: number;

	/** Number of pages processed */
	page_count: number;

	/** Processing time in milliseconds */
	processing_time_ms: number;

	/** Confidence score (0-100) if available */
	confidence?: number;
}

/**
 * OCR error details
 */
export interface OcrError {
	/** Error code (e.g., "TESSERACT_FAILED", "STORAGE_ERROR") */
	code: string;
	/** Detailed error message */
	message: string;
}

/**
 * OCR result payload - emitted to lattice.ocr.result.v1
 */
export interface OcrResultPayload {
	/** Matches request_id from OcrRequestPayload */
	request_id: string;

	/** Source info echoed back for routing */
	source: OcrSource;

	/** Extraction result */
	result: OcrResultDetails;

	/** Error details if status is "failed" */
	error?: OcrError;

	/** ISO timestamp when processing completed */
	completed_at: string;
}

// ─────────────────────────────────────────────────────────────
// DLQ (Dead Letter Queue)
// ─────────────────────────────────────────────────────────────

/**
 * DLQ failure reasons for OCR
 */
export type OcrDlqFailureReason =
	| "max_retries_exceeded"
	| "invalid_content"
	| "content_too_large"
	| "unsupported_format"
	| "processing_error"
	| "timeout";

/**
 * OCR DLQ entry - emitted to lattice.dlq.ocr.v1
 */
export interface OcrDlqPayload {
	/** The original OCR request that failed */
	original_request: OcrRequestPayload;
	/** Category of failure */
	failure_reason: OcrDlqFailureReason;
	/** Detailed error message */
	error_message: string;
	/** Stack trace if available */
	error_stack?: string;
	/** Number of retries attempted before DLQ */
	retry_count: number;
	/** When the first processing attempt occurred */
	first_attempt_at?: string;
	/** When the last processing attempt occurred */
	last_attempt_at?: string;
	/** When this message was sent to DLQ */
	dlq_at: string;
}

// ─────────────────────────────────────────────────────────────
// POSTGRES RECORD (for repository)
// ─────────────────────────────────────────────────────────────

/**
 * OCR result record stored in Postgres
 */
export interface OcrResultRecord {
	id: string;
	request_id: string;
	tenant_id: string;
	source_service: string;
	correlation_id: string;
	input_uri: string;
	input_mime_type: string;
	input_size_bytes?: number;
	status: OcrDbStatus;
	text_uri?: string;
	text_length?: number;
	page_count?: number;
	processing_time_ms?: number;
	confidence?: number;
	error_code?: string;
	error_message?: string;
	created_at: Date;
	completed_at?: Date;
}
