/**
 * Shared types for Kafka worker services
 */

/**
 * Envelope metadata from Kafka message
 */
export interface EnvelopeContext {
	/** Tenant ID */
	tenant_id: string;
	/** Account ID */
	account_id: string;
	/** Alias (stable label for routing) */
	alias?: string;
	/** Domain (e.g., 'mail') */
	domain: string;
	/** Stage (e.g., 'raw', 'parse') */
	stage?: string;
	/** Provider (e.g., 'gmail', 'imap') */
	provider?: string;
}

/**
 * Context passed to workers during message processing
 * Contains Kafka message metadata and optional tracing information
 */
export interface WorkerContext {
	/** Datadog trace ID for distributed tracing */
	traceId?: string;
	/** Datadog span ID for distributed tracing */
	spanId?: string;
	/** Kafka topic the message was consumed from */
	topic: string;
	/** Kafka partition the message was consumed from */
	partition: number;
	/** Kafka offset of the message */
	offset: string;
	/** Envelope metadata from the Kafka message */
	envelope?: EnvelopeContext;
}
