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
export type {
	WorkerHandler,
	WorkerContext,
} from "./kafka/base-worker.service.js";
