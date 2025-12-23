import { Kafka, logLevel, type KafkaConfig as KafkaJSConfig } from 'kafkajs';
import type { KafkaConfig } from '@lattice/core-config';
import type { Logger } from '@lattice/core-telemetry';

export interface KafkaClientOptions {
  config: KafkaConfig;
  logger: Logger;
}

function toKafkaLogLevel(level: string): logLevel {
  switch (level) {
    case 'debug':
      return logLevel.DEBUG;
    case 'info':
      return logLevel.INFO;
    case 'warn':
      return logLevel.WARN;
    case 'error':
      return logLevel.ERROR;
    default:
      return logLevel.INFO;
  }
}

export function createKafkaClient(options: KafkaClientOptions): Kafka {
  const { config, logger } = options;

  const kafkaConfig: KafkaJSConfig = {
    clientId: config.clientId,
    brokers: config.bootstrapServers.split(','),
    logLevel: toKafkaLogLevel('info'),
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
  if (config.securityProtocol === 'SASL_SSL') {
    kafkaConfig.ssl = true;
    kafkaConfig.sasl = {
      mechanism: config.saslMechanism.toLowerCase() as 'plain' | 'scram-sha-256' | 'scram-sha-512',
      username: config.saslUsername ?? '',
      password: config.saslPassword ?? '',
    };
  }

  return new Kafka(kafkaConfig);
}
