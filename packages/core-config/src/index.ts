export { loadConfig, type ConfigLoaderOptions } from "./loader.js";
export {
	baseConfigSchema,
	kafkaConfigSchema,
	postgresConfigSchema,
	datadogConfigSchema,
} from "./schemas.js";
export type {
	BaseConfig,
	KafkaConfig,
	PostgresConfig,
	DatadogConfig,
	ServiceIdentity,
} from "./schemas.js";
export { ConfigError, MissingEnvVarError, ValidationError } from "./errors.js";
