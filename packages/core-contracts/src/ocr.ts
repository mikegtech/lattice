/**
 * OCR request/result contracts - domain-agnostic OCR processing
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
 * Source domain for OCR requests
 */
export type OcrSourceDomain = "mail" | "property" | "other";

/**
 * OCR request priority
 */
export type OcrPriority = "low" | "normal" | "high";

/**
 * OCR processing status
 */
export type OcrStatus = "success" | "failed" | "partial";

/**
 * OCR request correlation data
 */
export interface OcrCorrelation {
	/** Topic that would have received this if OCR wasn't needed */
	original_topic?: string;
	/** Message ID from the extraction result */
	original_message_id?: string;
	/** Additional correlation data */
	[key: string]: unknown;
}

/**
 * OCR request payload - emitted to lattice.ocr.request.v1
 */
export interface OcrRequestPayload {
	/** Unique identifier for this OCR request */
	request_id: string;
	/** The domain that originated this OCR request */
	source_domain: OcrSourceDomain;
	/** ID of the parent document (email_id for mail, property_document_id for property) */
	document_id: string;
	/** ID of the specific part requiring OCR (attachment_id for mail) */
	part_id: string;
	/** Storage URI for the content to OCR */
	object_uri: string;
	/** MIME type of the content */
	content_type: string;
	/** Why OCR is needed for this content */
	ocr_reason: OcrReason;
	/** Optional language hint for OCR processing (ISO 639-1 code) */
	language_hint?: string;
	/** Processing priority */
	priority?: OcrPriority;
	/** Correlation data for tracing */
	correlation?: OcrCorrelation;
	/** When this request was created */
	created_at: string;
}

/**
 * OCR result payload - emitted to lattice.ocr.result.v1
 */
export interface OcrResultPayload {
	/** The request ID this result corresponds to */
	request_id: string;
	/** The domain that originated this OCR request */
	source_domain: OcrSourceDomain;
	/** ID of the parent document */
	document_id: string;
	/** ID of the specific part that was OCR'd */
	part_id: string;
	/** OCR processing status */
	status: OcrStatus;
	/** The text extracted via OCR (empty if failed) */
	extracted_text?: string;
	/** Character count of extracted text */
	extracted_text_length: number;
	/** Identifier of the OCR model used */
	ocr_model_id?: string;
	/** Version of the OCR service/model */
	ocr_version?: string;
	/** Overall confidence score for the OCR result (0-1) */
	confidence?: number;
	/** Number of pages processed */
	page_count?: number;
	/** Time taken to process OCR in milliseconds */
	processing_time_ms?: number;
	/** Error message if OCR failed */
	error?: string;
	/** Correlation data passed through from the request */
	correlation?: OcrCorrelation;
	/** When OCR processing completed */
	completed_at: string;
}

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
