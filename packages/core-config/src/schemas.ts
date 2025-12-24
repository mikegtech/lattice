import { z } from "zod";

export const serviceIdentitySchema = z.object({
	name: z.string().min(1),
	version: z.string().min(1),
	team: z.string().min(1),
	cloud: z.string().default("gcp"),
	region: z.string().default("us-central1"),
	domain: z.string().default("mail"),
	pipeline: z.string().default("mail-indexing"),
});

export type ServiceIdentity = z.infer<typeof serviceIdentitySchema>;

export const baseConfigSchema = z.object({
	env: z.enum(["dev", "staging", "prod"]).default("dev"),
	nodeEnv: z.enum(["development", "production", "test"]).default("development"),
	service: serviceIdentitySchema,
	logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type BaseConfig = z.infer<typeof baseConfigSchema>;

export const kafkaConfigSchema = z.object({
	bootstrapServers: z.string().min(1),
	securityProtocol: z
		.enum(["SASL_SSL", "PLAINTEXT", "SSL"])
		.default("SASL_SSL"),
	saslMechanism: z
		.enum(["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"])
		.default("PLAIN"),
	saslUsername: z.string().optional(),
	saslPassword: z.string().optional(),
	clientId: z.string().min(1),
	groupId: z.string().min(1),
	sessionTimeout: z.number().default(30000),
	heartbeatInterval: z.number().default(3000),
	maxRetries: z.number().default(5),
	retryBackoffMs: z.number().default(100),
});

export type KafkaConfig = z.infer<typeof kafkaConfigSchema>;

export const postgresConfigSchema = z.object({
	host: z.string().min(1),
	port: z.number().default(5432),
	database: z.string().min(1),
	user: z.string().min(1),
	password: z.string().min(1),
	ssl: z.boolean().default(false),
	poolMin: z.number().default(2),
	poolMax: z.number().default(10),
	connectionTimeout: z.number().default(10000),
});

export type PostgresConfig = z.infer<typeof postgresConfigSchema>;

export const datadogConfigSchema = z.object({
	apiKey: z.string().optional(),
	site: z.string().default("datadoghq.com"),
	env: z.string().min(1),
	service: z.string().min(1),
	version: z.string().min(1),
	logsInjection: z.boolean().default(true),
	traceEnabled: z.boolean().default(true),
	profilingEnabled: z.boolean().default(false),
	runtimeMetricsEnabled: z.boolean().default(true),
});

export type DatadogConfig = z.infer<typeof datadogConfigSchema>;
