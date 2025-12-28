// Config module
export { WorkerConfigModule, WORKER_CONFIG } from "./config/config.module.js";
export type {
	WorkerConfig,
	WorkerConfigOptions,
} from "./config/config.module.js";

// Kafka module
export { KafkaModule } from "./kafka/kafka.module.js";
export { KafkaService } from "./kafka/kafka.service.js";
export type { KafkaModuleOptions } from "./kafka/kafka.module.js";

// Telemetry module
export { TelemetryModule } from "./telemetry/telemetry.module.js";
export { TelemetryService } from "./telemetry/telemetry.service.js";
export { LoggerService, LOGGER } from "./telemetry/logger.service.js";
export type {
	LogContext,
	TieredLogContext,
} from "./telemetry/logger.service.js";
export { EventLogger, EVENT_LOGGER } from "./telemetry/events.js";
export {
	LogTier,
	type LoggingConfig,
	shouldForwardLog,
	PRODUCTION_LOGGING_CONFIG,
	LOCAL_LOGGING_CONFIG,
} from "./telemetry/log-tier.js";
export type {
	LatticeEvent,
	ServiceTags,
	BaseEvent,
	WorkerLifecycleEvent,
	WorkerStartingEvent,
	WorkerStartedEvent,
	WorkerShutdownInitiatedEvent,
	WorkerShutdownCompletedEvent,
	MessageProcessingEvent,
	KafkaConnectionEvent,
	KafkaConnectedEvent,
	KafkaErrorEvent,
	DatabaseEvent,
	HealthChangedEvent,
	EventName,
} from "./telemetry/events.types.js";

// Health module
export { HealthModule } from "./health/health.module.js";
export { HealthController } from "./health/health.controller.js";
export { HealthService, HEALTH_SERVICE } from "./health/health.service.js";

// Lifecycle module
export { LifecycleModule } from "./lifecycle/lifecycle.module.js";
export { LifecycleService } from "./lifecycle/lifecycle.service.js";
export type { ShutdownSignal } from "./lifecycle/lifecycle.service.js";

// Errors
export {
	WorkerError,
	RetryableWorkerError,
	NonRetryableWorkerError,
	classifyError,
} from "./errors/error-classifier.js";
export type { ErrorClassification } from "./errors/error-classifier.js";

// Base worker service
export { BaseWorkerService } from "./kafka/base-worker.service.js";
export type { WorkerHandler } from "./kafka/base-worker.service.js";
export type { WorkerContext } from "./kafka/types.js";
