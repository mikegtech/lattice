/**
 * Structured Event Types for Datadog
 *
 * These events are explicitly marked for Datadog indexing via the `dd.forward` attribute.
 * Events follow the `lattice.<domain>.<action>` naming convention.
 */

/**
 * Service identification tags included in all events
 */
export interface ServiceTags {
	service: string;
	version: string;
	env: string;
	team: string;
	cloud: string;
	region: string;
	domain: string;
	stage: string;
}

/**
 * Base event structure - all events extend this
 */
export interface BaseEvent {
	/** Event name following lattice.<domain>.<action> convention */
	event: string;
	/** ISO 8601 timestamp */
	timestamp: string;
	/** Signals Datadog should index this event */
	"dd.forward": true;
}

// ============================================================================
// Worker Lifecycle Events
// ============================================================================

export interface WorkerStartingEvent extends BaseEvent {
	event: "lattice.worker.starting";
	service: string;
	version: string;
	env: string;
}

export interface WorkerStartedEvent extends BaseEvent {
	event: "lattice.worker.started";
	service: string;
	version: string;
	env: string;
	config: {
		team: string;
		domain: string;
		stage: string;
		kafka_topic_in: string;
		kafka_topic_out?: string;
		health_port: number;
	};
}

export interface WorkerShutdownInitiatedEvent extends BaseEvent {
	event: "lattice.worker.shutdown.initiated";
	service: string;
	version: string;
	env: string;
	signal?: string;
	in_flight_count: number;
}

export interface WorkerShutdownCompletedEvent extends BaseEvent {
	event: "lattice.worker.shutdown.completed";
	service: string;
	version: string;
	env: string;
	duration_ms: number;
	reason: "graceful" | "error" | "signal";
}

/** @deprecated Use WorkerShutdownCompletedEvent instead */
export interface WorkerShutdownEvent extends BaseEvent {
	event: "lattice.worker.shutdown";
	service: string;
	version: string;
	env: string;
	duration_ms: number;
	in_flight_count: number;
	reason: "graceful" | "error" | "signal";
}

export type WorkerLifecycleEvent =
	| WorkerStartingEvent
	| WorkerStartedEvent
	| WorkerShutdownInitiatedEvent
	| WorkerShutdownCompletedEvent
	| WorkerShutdownEvent;

// ============================================================================
// Message Processing Events
// ============================================================================

export interface MessageProcessedEvent extends BaseEvent {
	event: "lattice.message.processed";
	message_id: string;
	email_id?: string;
	stage: string;
	duration_ms: number;
	output_topic?: string;
}

export interface MessageSkippedEvent extends BaseEvent {
	event: "lattice.message.skipped";
	message_id: string;
	email_id?: string;
	stage: string;
	reason: string;
}

export interface MessageRetryEvent extends BaseEvent {
	event: "lattice.message.retry";
	message_id: string;
	email_id?: string;
	stage: string;
	attempt: number;
	max_attempts: number;
	reason: string;
	backoff_ms: number;
}

export interface MessageDLQEvent extends BaseEvent {
	event: "lattice.message.dlq";
	message_id: string;
	email_id?: string;
	stage: string;
	reason: string;
	error_code: string;
	error_message: string;
	dlq_topic: string;
	/** Original input topic where the message came from */
	input_topic?: string;
	/** Kafka partition of the original message */
	kafka_partition?: number;
	/** Kafka offset of the original message */
	kafka_offset?: string;
}

export type MessageProcessingEvent =
	| MessageProcessedEvent
	| MessageSkippedEvent
	| MessageRetryEvent
	| MessageDLQEvent;

// ============================================================================
// Kafka Events
// ============================================================================

export interface KafkaConnectedEvent extends BaseEvent {
	event: "lattice.kafka.connected";
	broker: string;
	client_id: string;
	group_id: string;
	topic_in: string;
	topic_out?: string;
}

export interface KafkaDisconnectedEvent extends BaseEvent {
	event: "lattice.kafka.disconnected";
	broker: string;
	client_id: string;
	reason: string;
}

export interface KafkaErrorEvent extends BaseEvent {
	event: "lattice.kafka.error";
	broker: string;
	client_id: string;
	error_code: string;
	error_message: string;
	topic?: string;
	partition?: number;
}

export interface KafkaRebalanceEvent extends BaseEvent {
	event: "lattice.kafka.rebalance";
	client_id: string;
	group_id: string;
	action: "assign" | "revoke";
	partitions: number[];
	topic: string;
}

export type KafkaConnectionEvent =
	| KafkaConnectedEvent
	| KafkaDisconnectedEvent
	| KafkaRebalanceEvent;

// ============================================================================
// Database Events
// ============================================================================

export interface DatabaseConnectedEvent extends BaseEvent {
	event: "lattice.database.connected";
	database: string;
	host: string;
}

export interface DatabaseErrorEvent extends BaseEvent {
	event: "lattice.database.error";
	database: string;
	operation: string;
	error_code: string;
	error_message: string;
	query_duration_ms?: number;
}

export interface DatabaseSlowQueryEvent extends BaseEvent {
	event: "lattice.database.slow_query";
	database: string;
	operation: string;
	duration_ms: number;
	threshold_ms: number;
}

export type DatabaseEvent =
	| DatabaseConnectedEvent
	| DatabaseErrorEvent
	| DatabaseSlowQueryEvent;

// ============================================================================
// Health Events
// ============================================================================

export interface HealthChangedEvent extends BaseEvent {
	event: "lattice.health.changed";
	service: string;
	previous_status: "healthy" | "unhealthy" | "unknown";
	current_status: "healthy" | "unhealthy";
	reason: string;
	checks: Record<string, boolean>;
}

// ============================================================================
// Union of All Events
// ============================================================================

export type LatticeEvent =
	| WorkerLifecycleEvent
	| MessageProcessingEvent
	| KafkaConnectionEvent
	| KafkaErrorEvent
	| DatabaseEvent
	| HealthChangedEvent;

/**
 * Extract event name from event type
 */
export type EventName = LatticeEvent["event"];

/**
 * Get event type by name
 */
export type EventByName<T extends EventName> = Extract<
	LatticeEvent,
	{ event: T }
>;
