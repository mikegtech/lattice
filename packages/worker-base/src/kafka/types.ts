/**
 * Shared types for Kafka worker services
 */

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
}
