import type { ZodSchema } from "zod";
import { MissingEnvVarError, ValidationError } from "./errors.js";
import {
	type BaseConfig,
	type DatadogConfig,
	type KafkaConfig,
	type PostgresConfig,
	baseConfigSchema,
	datadogConfigSchema,
	kafkaConfigSchema,
	postgresConfigSchema,
} from "./schemas.js";

export interface ConfigLoaderOptions {
	/** Throw on missing optional vars instead of using defaults */
	strict?: boolean;
	/** Custom environment object (defaults to process.env) */
	env?: Record<string, string | undefined>;
}

interface EnvVarDef {
	key: string;
	required?: boolean;
	default?: string | number | boolean;
	transform?: (value: string) => string | number | boolean;
}

function getEnvVar(
	env: Record<string, string | undefined>,
	def: EnvVarDef,
	strict: boolean,
): string | number | boolean | undefined {
	const value = env[def.key];

	if (value === undefined || value === "") {
		if (def.required && strict) {
			throw new MissingEnvVarError(def.key);
		}
		return def.default;
	}

	if (def.transform) {
		return def.transform(value);
	}

	return value;
}

const toBool = (v: string): boolean => v.toLowerCase() === "true" || v === "1";
const toInt = (v: string): number => Number.parseInt(v, 10);

export interface FullConfig {
	base: BaseConfig;
	kafka: KafkaConfig;
	postgres: PostgresConfig;
	datadog: DatadogConfig;
}

export function loadConfig(options: ConfigLoaderOptions = {}): FullConfig {
	const env = options.env ?? process.env;
	const strict = options.strict ?? false;

	// Extract commonly reused values first
	const serviceName = String(
		getEnvVar(env, { key: "SERVICE_NAME", required: true }, strict) ?? "",
	);
	const serviceVersion = String(
		getEnvVar(env, { key: "SERVICE_VERSION", required: true }, strict) ?? "",
	);
	const envName = String(
		getEnvVar(env, { key: "ENV", default: "dev" }, strict) ?? "dev",
	);

	const baseRaw = {
		env: envName,
		nodeEnv: getEnvVar(
			env,
			{ key: "NODE_ENV", default: "development" },
			strict,
		),
		service: {
			name: serviceName,
			version: serviceVersion,
			team: getEnvVar(env, { key: "TEAM", default: "platform" }, strict),
			cloud: getEnvVar(env, { key: "CLOUD", default: "gcp" }, strict),
			region: getEnvVar(env, { key: "REGION", default: "us-central1" }, strict),
			domain: getEnvVar(env, { key: "DOMAIN", default: "mail" }, strict),
			pipeline: getEnvVar(
				env,
				{ key: "PIPELINE", default: "mail-indexing" },
				strict,
			),
		},
		logLevel: getEnvVar(env, { key: "LOG_LEVEL", default: "info" }, strict),
	};

	const kafkaRaw = {
		bootstrapServers: getEnvVar(
			env,
			{ key: "KAFKA_BOOTSTRAP_SERVERS", required: true },
			strict,
		),
		securityProtocol: getEnvVar(
			env,
			{ key: "KAFKA_SECURITY_PROTOCOL", default: "SASL_SSL" },
			strict,
		),
		saslMechanism: getEnvVar(
			env,
			{ key: "KAFKA_SASL_MECHANISM", default: "PLAIN" },
			strict,
		),
		saslUsername: getEnvVar(env, { key: "KAFKA_SASL_USERNAME" }, strict),
		saslPassword: getEnvVar(env, { key: "KAFKA_SASL_PASSWORD" }, strict),
		clientId: getEnvVar(
			env,
			{ key: "KAFKA_CLIENT_ID", default: serviceName },
			strict,
		),
		groupId: getEnvVar(
			env,
			{ key: "KAFKA_GROUP_ID", default: `${serviceName}-group` },
			strict,
		),
		sessionTimeout: getEnvVar(
			env,
			{ key: "KAFKA_SESSION_TIMEOUT", default: 30000, transform: toInt },
			strict,
		),
		heartbeatInterval: getEnvVar(
			env,
			{ key: "KAFKA_HEARTBEAT_INTERVAL", default: 3000, transform: toInt },
			strict,
		),
		maxRetries: getEnvVar(
			env,
			{ key: "KAFKA_MAX_RETRIES", default: 5, transform: toInt },
			strict,
		),
		retryBackoffMs: getEnvVar(
			env,
			{ key: "KAFKA_RETRY_BACKOFF_MS", default: 100, transform: toInt },
			strict,
		),
	};

	const postgresRaw = {
		host: getEnvVar(
			env,
			{ key: "POSTGRES_HOST", default: "localhost" },
			strict,
		),
		port: getEnvVar(
			env,
			{ key: "POSTGRES_PORT", default: 5432, transform: toInt },
			strict,
		),
		database: getEnvVar(
			env,
			{ key: "POSTGRES_DB", default: "lattice" },
			strict,
		),
		user: getEnvVar(env, { key: "POSTGRES_USER", default: "lattice" }, strict),
		password: getEnvVar(
			env,
			{ key: "POSTGRES_PASSWORD", required: true },
			strict,
		),
		ssl: getEnvVar(
			env,
			{ key: "POSTGRES_SSL", default: false, transform: toBool },
			strict,
		),
		poolMin: getEnvVar(
			env,
			{ key: "POSTGRES_POOL_MIN", default: 2, transform: toInt },
			strict,
		),
		poolMax: getEnvVar(
			env,
			{ key: "POSTGRES_POOL_MAX", default: 10, transform: toInt },
			strict,
		),
		connectionTimeout: getEnvVar(
			env,
			{ key: "POSTGRES_CONNECTION_TIMEOUT", default: 10000, transform: toInt },
			strict,
		),
	};

	const datadogRaw = {
		apiKey: getEnvVar(env, { key: "DD_API_KEY" }, strict),
		site: getEnvVar(env, { key: "DD_SITE", default: "datadoghq.com" }, strict),
		env: getEnvVar(env, { key: "DD_ENV", default: envName }, strict),
		service: getEnvVar(
			env,
			{ key: "DD_SERVICE", default: serviceName },
			strict,
		),
		version: getEnvVar(
			env,
			{ key: "DD_VERSION", default: serviceVersion },
			strict,
		),
		logsInjection: getEnvVar(
			env,
			{ key: "DD_LOGS_INJECTION", default: true, transform: toBool },
			strict,
		),
		traceEnabled: getEnvVar(
			env,
			{ key: "DD_TRACE_ENABLED", default: true, transform: toBool },
			strict,
		),
		profilingEnabled: getEnvVar(
			env,
			{ key: "DD_PROFILING_ENABLED", default: false, transform: toBool },
			strict,
		),
		runtimeMetricsEnabled: getEnvVar(
			env,
			{ key: "DD_RUNTIME_METRICS_ENABLED", default: true, transform: toBool },
			strict,
		),
	};

	const validateSchema = <T>(
		schema: ZodSchema<T>,
		data: unknown,
		name: string,
	): T => {
		const result = schema.safeParse(data);
		if (!result.success) {
			const errors = result.error.errors.map((e) => ({
				path: e.path.join("."),
				message: e.message,
			}));
			throw new ValidationError(`Invalid ${name} configuration`, errors);
		}
		return result.data;
	};

	// Validate with Zod - it applies defaults and transforms
	return {
		base: validateSchema(baseConfigSchema, baseRaw, "base"),
		kafka: validateSchema(kafkaConfigSchema, kafkaRaw, "kafka"),
		postgres: validateSchema(postgresConfigSchema, postgresRaw, "postgres"),
		datadog: validateSchema(datadogConfigSchema, datadogRaw, "datadog"),
	} as FullConfig;
}
