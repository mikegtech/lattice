// Mail event payloads
export type {
	MailRawPayload,
	MailParsePayload,
	MailChunkPayload,
	MailChunkSummaryPayload,
	MailEmbedPayload,
	MailUpsertPayload,
	MailDeletePayload,
	EmailAddress,
	EmailHeaders,
	EmailBody,
	Attachment,
	ChunkSourceType,
	SectionType,
} from "./mail.js";

// DLQ and audit payloads
export type { DLQPayload, AuditEventPayload } from "./dlq.js";

// Schema versions
export { SCHEMA_VERSIONS } from "./versions.js";
