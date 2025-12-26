/**
 * Raw mail event payload - from Gmail API
 */
export interface MailRawPayload {
	/** Gmail message ID (unique within account) */
	provider_message_id: string;
	/** Lattice-assigned unique email ID */
	email_id: string;
	/** Gmail thread ID */
	thread_id: string;
	/** Gmail history ID for incremental sync */
	history_id?: string;
	/** Gmail label IDs */
	label_ids?: string[];
	/** Base64url-encoded RFC822/MIME message */
	raw_payload: string;
	/** Object storage URI for large payloads */
	raw_object_uri?: string;
	/** Size of raw payload in bytes */
	size_bytes: number;
	/** Gmail internal date */
	internal_date: string;
	/** When this message was fetched from Gmail */
	fetched_at: string;
}

/**
 * Email address with optional display name
 */
export interface EmailAddress {
	name?: string;
	address: string;
}

/**
 * Parsed email headers
 */
export interface EmailHeaders {
	/** RFC822 Message-ID header */
	message_id?: string;
	/** In-Reply-To header */
	in_reply_to?: string;
	/** References header */
	references?: string[];
	/** Email subject */
	subject: string;
	/** Sender */
	from: EmailAddress;
	/** Recipients */
	to?: EmailAddress[];
	/** CC recipients */
	cc?: EmailAddress[];
	/** BCC recipients */
	bcc?: EmailAddress[];
	/** Reply-To address */
	reply_to?: EmailAddress;
	/** Email date */
	date: string;
	/** Additional headers */
	[key: string]: unknown;
}

/**
 * Email body content
 */
export interface EmailBody {
	/** Plain text body */
	text_plain?: string;
	/** HTML body */
	text_html?: string;
	/** Normalized text for indexing */
	text_normalized?: string;
}

/**
 * Attachment metadata
 */
export interface Attachment {
	/** Unique attachment ID */
	attachment_id: string;
	/** Original filename */
	filename: string;
	/** MIME type */
	mime_type: string;
	/** Size in bytes */
	size_bytes: number;
	/** SHA-256 hash of content */
	content_hash: string;
	/** Object storage URI */
	storage_uri?: string;
	/** Extracted text (if applicable) */
	extracted_text?: string;
	/** Text extraction status */
	extraction_status?: "pending" | "success" | "failed" | "unsupported";
}

/**
 * Parsed mail event payload
 */
export interface MailParsePayload {
	/** Gmail message ID */
	provider_message_id: string;
	/** Lattice email ID */
	email_id: string;
	/** Gmail thread ID */
	thread_id: string;
	/** SHA-256 hash of normalized content */
	content_hash: string;
	/** Parsed headers */
	headers: EmailHeaders;
	/** Email body */
	body: EmailBody;
	/** Attachment manifest */
	attachments: Attachment[];
	/** When this email was parsed */
	parsed_at: string;
}

/**
 * Chunk source types
 */
export type ChunkSourceType = "body" | "attachment" | "subject";

/**
 * Semantic section types
 */
export type SectionType =
	| "header"
	| "greeting"
	| "body"
	| "signature"
	| "quote"
	| "attachment_text";

/**
 * Mail chunk event payload
 */
export interface MailChunkPayload {
	/** Gmail message ID */
	provider_message_id: string;
	/** Lattice email ID */
	email_id: string;
	/** Parent email content hash */
	content_hash: string;
	/** Unique chunk ID */
	chunk_id: string;
	/** SHA-256 hash of chunk text + versioning for dedup */
	chunk_hash: string;
	/** Position within source */
	chunk_index: number;
	/** Total chunks for this source */
	total_chunks: number;
	/** Chunk text content */
	chunk_text: string;
	/** Character count */
	char_count: number;
	/** Estimated token count */
	token_count_estimate?: number;
	/** Source of this chunk */
	source_type: ChunkSourceType;
	/** Attachment ID if from attachment */
	attachment_id?: string;
	/** Semantic section type */
	section_type?: SectionType;
	/** Chunking algorithm version */
	chunking_version: string;
	/** Text normalization version */
	normalization_version: string;
	/** When chunk was created */
	chunked_at: string;
}

/**
 * Summary event emitted after all chunks are created
 */
export interface MailChunkSummaryPayload {
	/** Lattice email ID */
	email_id: string;
	/** Parent email content hash */
	content_hash: string;
	/** Total number of chunks created */
	chunk_count: number;
	/** List of chunk hashes for verification */
	chunk_hashes: string[];
	/** Chunking algorithm version */
	chunking_version: string;
	/** Text normalization version */
	normalization_version: string;
	/** Section breakdown */
	section_counts: Record<SectionType, number>;
	/** When chunking completed */
	chunked_at: string;
}

/**
 * Mail embed event payload
 * Note: Vector is stored in Postgres, not in the event payload to avoid large messages
 */
export interface MailEmbedPayload {
	/** Gmail message ID */
	provider_message_id: string;
	/** Lattice email ID */
	email_id: string;
	/** Chunk ID */
	chunk_id: string;
	/** Chunk hash */
	chunk_hash: string;
	/** Unique embedding ID */
	embedding_id: string;
	/** Embedding version identifier */
	embedding_version: string;
	/** Model used for embedding */
	embedding_model: string;
	/** Vector dimensions */
	embedding_dimensions: number;
	/** Storage location for the vector */
	vector_storage: "postgres";
	/** When embedding was generated */
	embedded_at: string;
}

/**
 * Mail upsert event payload
 */
export interface MailUpsertPayload {
	/** Gmail message ID */
	provider_message_id: string;
	/** Lattice email ID */
	email_id: string;
	/** Chunk ID */
	chunk_id: string;
	/** Chunk hash */
	chunk_hash: string;
	/** Embedding ID */
	embedding_id: string;
	/** Embedding version */
	embedding_version: string;
	/** Milvus collection */
	milvus_collection: string;
	/** Milvus partition */
	milvus_partition?: string;
	/** Vector ID in Milvus */
	vector_id: string;
	/** When upserted */
	upserted_at: string;
	/** Whether this was an update */
	is_update: boolean;
}

/**
 * Deletion reason types
 */
export type DeletionReason =
	| "user_request"
	| "retention_policy"
	| "reprocess"
	| "gdpr_request"
	| "admin_action";

/**
 * Mail delete event payload
 */
export interface MailDeletePayload {
	/** Gmail message ID */
	provider_message_id: string;
	/** Lattice email ID */
	email_id: string;
	/** Soft or hard delete */
	deletion_type: "soft" | "hard";
	/** Reason for deletion */
	deletion_reason: DeletionReason;
	/** Delete vectors from Milvus */
	delete_vectors?: boolean;
	/** Delete from object storage */
	delete_storage?: boolean;
	/** Delete from Postgres */
	delete_postgres?: boolean;
	/** Who requested deletion */
	requested_by?: string;
	/** When deletion was requested */
	requested_at: string;
}
