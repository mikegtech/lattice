// Mail event payloads
export type {
	MailRawPayload,
	MailParsePayload,
	MailChunkPayload,
	MailChunkSummaryPayload,
	MailEmbedPayload,
	MailUpsertPayload,
	MailDeletePayload,
	MailDeleteRequestPayload,
	MailDeleteCompletedPayload,
	DeleteRequestType,
	DeletionReason,
	EmailAddress,
	EmailHeaders,
	EmailBody,
	Attachment,
	ChunkSourceType,
	SectionType,
	AttachmentExtractRequest,
	AttachmentExtractResult,
	ExtractableAttachment,
	AttachmentTextReadyPayload,
	AttachmentTextSource,
	AttachmentTextQuality,
} from "./mail.js";

// OCR payloads
export type {
	OcrReason,
	OcrSourceDomain,
	OcrPriority,
	OcrStatus,
	OcrCorrelation,
	OcrRequestPayload,
	OcrResultPayload,
	OcrDlqFailureReason,
	OcrDlqPayload,
} from "./ocr.js";

// DLQ and audit payloads
export type { DLQPayload, AuditEventPayload } from "./dlq.js";

// Schema versions
export { SCHEMA_VERSIONS } from "./versions.js";
