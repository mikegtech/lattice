/**
 * DLQ error classifications
 */
export type ErrorClassification = "retryable" | "non_retryable" | "poison";

/**
 * DLQ event payload
 */
export interface DLQPayload {
	/** Unique DLQ entry ID */
	dlq_id: string;
	/** Original Kafka topic */
	original_topic: string;
	/** Original partition */
	original_partition?: number;
	/** Original offset */
	original_offset?: number;
	/** Original message key */
	original_key?: string;
	/** Original message (envelope + payload) */
	original_message: unknown;
	/** Pipeline stage where failure occurred */
	failure_stage: string;
	/** Error classification */
	error_classification: ErrorClassification;
	/** Application error code */
	error_code: string;
	/** Human-readable error message */
	error_message: string;
	/** Stack trace */
	error_stack?: string;
	/** Number of retry attempts */
	retry_count: number;
	/** First failure timestamp */
	first_failed_at: string;
	/** Last failure timestamp */
	last_failed_at: string;
	/** When sent to DLQ */
	dlq_at: string;
	/** Service that failed */
	processing_service: string;
	/** Instance ID */
	processing_instance?: string;
}

/**
 * Audit event types
 */
export type AuditEventType =
	| "email.ingested"
	| "email.parsed"
	| "email.chunked"
	| "email.embedded"
	| "email.indexed"
	| "email.deleted"
	| "email.reprocessed"
	| "attachment.extracted"
	| "attachment.ocr_completed"
	| "vector.upserted"
	| "vector.deleted"
	| "sync.started"
	| "sync.completed"
	| "sync.failed"
	| "backfill.started"
	| "backfill.completed"
	| "reindex.started"
	| "reindex.completed"
	| "dlq.message_added"
	| "dlq.message_replayed";

/**
 * Audit entity types
 */
export type AuditEntityType =
	| "email"
	| "attachment"
	| "chunk"
	| "embedding"
	| "sync"
	| "backfill";

/**
 * Audit action types
 */
export type AuditAction =
	| "create"
	| "update"
	| "delete"
	| "process"
	| "retry"
	| "skip";

/**
 * Audit outcome types
 */
export type AuditOutcome = "success" | "failure" | "skipped" | "partial";

/**
 * Audit event metrics
 */
export interface AuditMetrics {
	duration_ms?: number;
	bytes_processed?: number;
	items_processed?: number;
	[key: string]: unknown;
}

/**
 * Audit correlation info
 */
export interface AuditCorrelation {
	trace_id?: string;
	span_id?: string;
	parent_audit_id?: string;
	dag_run_id?: string;
	task_id?: string;
}

/**
 * Audit actor info
 */
export interface AuditActor {
	service: string;
	version?: string;
	instance_id?: string;
}

/**
 * Audit event payload
 */
export interface AuditEventPayload {
	/** Unique audit event ID */
	audit_id: string;
	/** Event type */
	event_type: AuditEventType;
	/** Entity type */
	entity_type: AuditEntityType;
	/** Entity ID */
	entity_id?: string;
	/** Gmail message ID if applicable */
	provider_message_id?: string;
	/** Lattice email ID if applicable */
	email_id?: string;
	/** Action performed */
	action: AuditAction;
	/** Outcome */
	outcome: AuditOutcome;
	/** Additional details */
	details?: Record<string, unknown>;
	/** Metrics */
	metrics?: AuditMetrics;
	/** Correlation info */
	correlation?: AuditCorrelation;
	/** Actor info */
	actor: AuditActor;
	/** Event timestamp */
	timestamp: string;
}
