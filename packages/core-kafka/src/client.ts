import type { KafkaConfig } from "@lattice/core-config";
import type { Logger } from "@lattice/core-telemetry";
import { Kafka, type KafkaConfig as KafkaJSConfig, logLevel } from "kafkajs";

export interface KafkaClientOptions {
	config: KafkaConfig;
	logger: Logger;
}

function toKafkaLogLevel(level: string): logLevel {
	switch (level) {
		case "debug":
			return logLevel.DEBUG;
		case "info":
			return logLevel.INFO;
		case "warn":
			return logLevel.WARN;
		case "error":
			return logLevel.ERROR;
		default:
			return logLevel.INFO;
	}
}

export function createKafkaClient(options: KafkaClientOptions): Kafka {
	const { config, logger } = options;

	const kafkaConfig: KafkaJSConfig = {
		clientId: config.clientId,
		brokers: config.bootstrapServers.split(","),
		logLevel: toKafkaLogLevel("info"),
		logCreator: () => {
			return ({ log }) => {
				const { message, ...extra } = log;
				logger.debug(message, extra as Record<string, unknown>);
			};
		},
		retry: {
			retries: config.maxRetries,
			initialRetryTime: config.retryBackoffMs,
			maxRetryTime: 30000,
		},
	};

	// Add SASL config for Confluent Cloud
	if (config.securityProtocol === "SASL_SSL") {
		kafkaConfig.ssl = true;
		const mechanism = config.saslMechanism.toLowerCase();
		if (mechanism === "plain") {
			kafkaConfig.sasl = {
				mechanism: "plain" as const,
				username: config.saslUsername ?? "",
				password: config.saslPassword ?? "",
			};
		} else if (mechanism === "scram-sha-256") {
			kafkaConfig.sasl = {
				mechanism: "scram-sha-256" as const,
				username: config.saslUsername ?? "",
				password: config.saslPassword ?? "",
			};
		} else if (mechanism === "scram-sha-512") {
			kafkaConfig.sasl = {
				mechanism: "scram-sha-512" as const,
				username: config.saslUsername ?? "",
				password: config.saslPassword ?? "",
			};
		}
	}

	return new Kafka(kafkaConfig);
}
