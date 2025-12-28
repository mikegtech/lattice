/**
 * EventLogger - Structured event logging for Datadog
 *
 * Emits typed events that are guaranteed to be indexed by Datadog.
 * All events include the `dd.forward: true` attribute for indexing.
 */

import { Injectable } from "@nestjs/common";
import type { WorkerConfig } from "../config/config.module.js";
import type { WorkerContext } from "../kafka/types.js";
import type {
	BaseEvent,
	DatabaseErrorEvent,
	DatabaseSlowQueryEvent,
	HealthChangedEvent,
	KafkaConnectedEvent,
	KafkaDisconnectedEvent,
	KafkaErrorEvent,
	KafkaRebalanceEvent,
	MessageDLQEvent,
	MessageProcessedEvent,
	MessageRetryEvent,
	MessageSkippedEvent,
	ServiceTags,
	WorkerShutdownCompletedEvent,
	WorkerShutdownEvent,
	WorkerShutdownInitiatedEvent,
	WorkerStartedEvent,
	WorkerStartingEvent,
} from "./events.types.js";
import type { LoggerService } from "./logger.service.js";

export const EVENT_LOGGER = "EVENT_LOGGER";

/**
 * Creates a base event with timestamp and dd.forward flag
 */
function createBaseEvent<T extends string>(event: T): BaseEvent & { event: T } {
	return {
		event,
		timestamp: new Date().toISOString(),
		"dd.forward": true,
	};
}

@Injectable()
export class EventLogger {
	private readonly baseTags: ServiceTags;

	constructor(
		private readonly logger: LoggerService,
		private readonly config: WorkerConfig,
	) {
		this.baseTags = {
			service: config.service,
			version: config.version,
			env: config.env,
			team: config.team,
			cloud: config.cloud,
			region: config.region,
			domain: config.domain,
			stage: config.stage,
		};
	}

	/**
	 * Emit an event to the logger with full structure
	 */
	private emit<T extends BaseEvent>(event: T): void {
		// Merge base tags with event-specific fields
		const fullEvent = {
			...this.baseTags,
			...(event as unknown as Record<string, unknown>),
		};
		this.logger.info(event.event, fullEvent);
	}

	// ==========================================================================
	// Worker Lifecycle Events
	// ==========================================================================

	/**
	 * Emit when worker is starting (before modules init)
	 */
	workerStarting(): void {
		const event: WorkerStartingEvent = {
			...createBaseEvent("lattice.worker.starting"),
			service: this.baseTags.service,
			version: this.baseTags.version,
			env: this.baseTags.env,
		};
		this.emit(event);
	}

	/**
	 * Emit when worker starts successfully (after listening)
	 */
	workerStarted(): void {
		const event: WorkerStartedEvent = {
			...createBaseEvent("lattice.worker.started"),
			service: this.baseTags.service,
			version: this.baseTags.version,
			env: this.baseTags.env,
			config: {
				team: this.config.team,
				domain: this.config.domain,
				stage: this.config.stage,
				kafka_topic_in: this.config.kafka.topicIn,
				kafka_topic_out: this.config.kafka.topicOut,
				health_port: this.config.healthPort,
			},
		};
		this.emit(event);
	}

	/**
	 * Emit when worker shutdown is initiated
	 */
	workerShutdownInitiated(inFlightCount: number, signal?: string): void {
		const event: WorkerShutdownInitiatedEvent = {
			...createBaseEvent("lattice.worker.shutdown.initiated"),
			service: this.baseTags.service,
			version: this.baseTags.version,
			env: this.baseTags.env,
			in_flight_count: inFlightCount,
		};
		if (signal) event.signal = signal;
		this.emit(event);
	}

	/**
	 * Emit when worker shutdown completes
	 */
	workerShutdownCompleted(
		durationMs: number,
		reason: "graceful" | "error" | "signal",
	): void {
		const event: WorkerShutdownCompletedEvent = {
			...createBaseEvent("lattice.worker.shutdown.completed"),
			service: this.baseTags.service,
			version: this.baseTags.version,
			env: this.baseTags.env,
			duration_ms: durationMs,
			reason,
		};
		this.emit(event);
	}

	/**
	 * @deprecated Use workerShutdownCompleted instead
	 * Emit when worker shuts down
	 */
	workerShutdown(
		durationMs: number,
		inFlightCount: number,
		reason: "graceful" | "error" | "signal",
	): void {
		const event: WorkerShutdownEvent = {
			...createBaseEvent("lattice.worker.shutdown"),
			service: this.baseTags.service,
			version: this.baseTags.version,
			env: this.baseTags.env,
			duration_ms: durationMs,
			in_flight_count: inFlightCount,
			reason,
		};
		this.emit(event);
	}

	// ==========================================================================
	// Message Processing Events
	// ==========================================================================

	/**
	 * Emit when a message is successfully processed
	 */
	messageProcessed(
		messageId: string,
		durationMs: number,
		options?: { emailId?: string; outputTopic?: string },
	): void {
		const event: MessageProcessedEvent = {
			...createBaseEvent("lattice.message.processed"),
			message_id: messageId,
			stage: this.baseTags.stage,
			duration_ms: durationMs,
		};
		if (options?.emailId) event.email_id = options.emailId;
		if (options?.outputTopic) event.output_topic = options.outputTopic;
		this.emit(event);
	}

	/**
	 * Emit when a message is skipped (idempotency, filter, etc.)
	 */
	messageSkipped(messageId: string, reason: string, emailId?: string): void {
		const event: MessageSkippedEvent = {
			...createBaseEvent("lattice.message.skipped"),
			message_id: messageId,
			stage: this.baseTags.stage,
			reason,
		};
		if (emailId) event.email_id = emailId;
		this.emit(event);
	}

	/**
	 * Emit when a message is being retried
	 */
	messageRetry(
		messageId: string,
		attempt: number,
		maxAttempts: number,
		reason: string,
		backoffMs: number,
		emailId?: string,
	): void {
		const event: MessageRetryEvent = {
			...createBaseEvent("lattice.message.retry"),
			message_id: messageId,
			stage: this.baseTags.stage,
			attempt,
			max_attempts: maxAttempts,
			reason,
			backoff_ms: backoffMs,
		};
		if (emailId) event.email_id = emailId;
		this.emit(event);
	}

	/**
	 * Emit when a message is sent to DLQ
	 */
	messageDLQ(
		messageId: string,
		reason: string,
		errorCode: string,
		errorMessage: string,
		emailId?: string,
		context?: WorkerContext,
	): void {
		const event: MessageDLQEvent = {
			...createBaseEvent("lattice.message.dlq"),
			message_id: messageId,
			stage: this.baseTags.stage,
			reason,
			error_code: errorCode,
			error_message: errorMessage,
			dlq_topic: this.config.kafka.topicDlq,
			...(emailId && { email_id: emailId }),
			...(context?.topic && { input_topic: context.topic }),
			...(context?.partition !== undefined && {
				kafka_partition: context.partition,
			}),
			...(context?.offset && { kafka_offset: context.offset }),
		};
		this.emit(event);
	}

	// ==========================================================================
	// Kafka Events
	// ==========================================================================

	/**
	 * Emit when Kafka connection is established
	 */
	kafkaConnected(broker?: string): void {
		const event: KafkaConnectedEvent = {
			...createBaseEvent("lattice.kafka.connected"),
			broker: broker ?? this.config.kafka.brokers.join(","),
			client_id: this.config.kafka.clientId,
			group_id: this.config.kafka.groupId,
			topic_in: this.config.kafka.topicIn,
		};
		if (this.config.kafka.topicOut)
			event.topic_out = this.config.kafka.topicOut;
		this.emit(event);
	}

	/**
	 * Emit when Kafka connection is lost
	 */
	kafkaDisconnected(broker: string, reason: string): void {
		const event: KafkaDisconnectedEvent = {
			...createBaseEvent("lattice.kafka.disconnected"),
			broker,
			client_id: this.config.kafka.clientId,
			reason,
		};
		this.emit(event);
	}

	/**
	 * Emit on Kafka error
	 */
	kafkaError(
		broker: string,
		errorCode: string,
		errorMessage: string,
		options?: { topic?: string; partition?: number },
	): void {
		const event: KafkaErrorEvent = {
			...createBaseEvent("lattice.kafka.error"),
			broker,
			client_id: this.config.kafka.clientId,
			error_code: errorCode,
			error_message: errorMessage,
		};
		if (options?.topic) event.topic = options.topic;
		if (options?.partition !== undefined) event.partition = options.partition;
		this.emit(event);
	}

	/**
	 * Emit on Kafka consumer group rebalance
	 */
	kafkaRebalance(
		action: "assign" | "revoke",
		topic: string,
		partitions: number[],
	): void {
		const event: KafkaRebalanceEvent = {
			...createBaseEvent("lattice.kafka.rebalance"),
			client_id: this.config.kafka.clientId,
			group_id: this.config.kafka.groupId,
			action,
			topic,
			partitions,
		};
		this.emit(event);
	}

	// ==========================================================================
	// Database Events
	// ==========================================================================

	/**
	 * Emit on database error
	 */
	databaseError(
		database: string,
		operation: string,
		errorCode: string,
		errorMessage: string,
		queryDurationMs?: number,
	): void {
		const event: DatabaseErrorEvent = {
			...createBaseEvent("lattice.database.error"),
			database,
			operation,
			error_code: errorCode,
			error_message: errorMessage,
		};
		if (queryDurationMs !== undefined)
			event.query_duration_ms = queryDurationMs;
		this.emit(event);
	}

	/**
	 * Emit on slow database query
	 */
	databaseSlowQuery(
		database: string,
		operation: string,
		durationMs: number,
		thresholdMs: number,
	): void {
		const event: DatabaseSlowQueryEvent = {
			...createBaseEvent("lattice.database.slow_query"),
			database,
			operation,
			duration_ms: durationMs,
			threshold_ms: thresholdMs,
		};
		this.emit(event);
	}

	// ==========================================================================
	// Health Events
	// ==========================================================================

	/**
	 * Emit when health status changes
	 */
	healthChanged(
		previousStatus: "healthy" | "unhealthy" | "unknown",
		currentStatus: "healthy" | "unhealthy",
		reason: string,
		checks: Record<string, boolean>,
	): void {
		const event: HealthChangedEvent = {
			...createBaseEvent("lattice.health.changed"),
			service: this.baseTags.service,
			previous_status: previousStatus,
			current_status: currentStatus,
			reason,
			checks,
		};
		this.emit(event);
	}
}
