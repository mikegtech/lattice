import { Module, Global, DynamicModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { z } from 'zod';

/**
 * Standard environment variable schema for all Lattice workers
 */
const workerEnvSchema = z.object({
  // Datadog unified service tags
  DD_ENV: z.string().default('dev'),
  DD_SERVICE: z.string(),
  DD_VERSION: z.string().default('0.1.0'),

  // Lattice context tags
  LATTICE_TEAM: z.string().default('lattice'),
  LATTICE_CLOUD: z.enum(['local', 'gcp', 'aws', 'edge']).default('local'),
  LATTICE_REGION: z.string().default('local'),
  LATTICE_DOMAIN: z.string(),
  LATTICE_STAGE: z.string(),

  // Kafka configuration
  KAFKA_BROKERS: z.string(),
  KAFKA_CLIENT_ID: z.string(),
  KAFKA_GROUP_ID: z.string(),
  KAFKA_SASL_MECHANISM: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']).default('plain'),
  KAFKA_SASL_USERNAME: z.string().optional(),
  KAFKA_SASL_PASSWORD: z.string().optional(),
  KAFKA_SSL: z.string().transform((v: string) => v === 'true').default('true'),
  KAFKA_TOPIC_IN: z.string(),
  KAFKA_TOPIC_OUT: z.string().optional(),
  KAFKA_TOPIC_DLQ: z.string(),

  // Database
  DATABASE_URL: z.string().optional(),

  // Worker settings
  KAFKA_MAX_RETRIES: z.string().transform(Number).default('3'),
  KAFKA_RETRY_BACKOFF_MS: z.string().transform(Number).default('1000'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  HEALTH_PORT: z.string().transform(Number).default('3000'),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export interface WorkerConfig {
  // Service identity
  service: string;
  version: string;
  env: string;

  // Lattice tags
  team: string;
  cloud: string;
  region: string;
  domain: string;
  stage: string;

  // Kafka
  kafka: {
    brokers: string[];
    clientId: string;
    groupId: string;
    ssl: boolean;
    sasl?: {
      mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
      username: string;
      password: string;
    };
    topicIn: string;
    topicOut?: string;
    topicDlq: string;
    maxRetries: number;
    retryBackoffMs: number;
  };

  // Database
  databaseUrl?: string;

  // Server
  logLevel: string;
  healthPort: number;
}

export const WORKER_CONFIG = 'WORKER_CONFIG';

export interface WorkerConfigOptions {
  envFilePath?: string;
}

function validateAndTransform(): WorkerConfig {
  const parsed = workerEnvSchema.parse(process.env);

  return {
    service: parsed.DD_SERVICE,
    version: parsed.DD_VERSION,
    env: parsed.DD_ENV,

    team: parsed.LATTICE_TEAM,
    cloud: parsed.LATTICE_CLOUD,
    region: parsed.LATTICE_REGION,
    domain: parsed.LATTICE_DOMAIN,
    stage: parsed.LATTICE_STAGE,

    kafka: (() => {
      const kafkaConfig: WorkerConfig['kafka'] = {
        brokers: parsed.KAFKA_BROKERS.split(','),
        clientId: parsed.KAFKA_CLIENT_ID,
        groupId: parsed.KAFKA_GROUP_ID,
        ssl: parsed.KAFKA_SSL,
        topicIn: parsed.KAFKA_TOPIC_IN,
        topicDlq: parsed.KAFKA_TOPIC_DLQ,
        maxRetries: parsed.KAFKA_MAX_RETRIES,
        retryBackoffMs: parsed.KAFKA_RETRY_BACKOFF_MS,
      };
      if (parsed.KAFKA_TOPIC_OUT) kafkaConfig.topicOut = parsed.KAFKA_TOPIC_OUT;
      if (parsed.KAFKA_SASL_USERNAME && parsed.KAFKA_SASL_PASSWORD) {
        kafkaConfig.sasl = {
          mechanism: parsed.KAFKA_SASL_MECHANISM,
          username: parsed.KAFKA_SASL_USERNAME,
          password: parsed.KAFKA_SASL_PASSWORD,
        };
      }
      return kafkaConfig;
    })(),

    ...(parsed.DATABASE_URL && { databaseUrl: parsed.DATABASE_URL }),
    logLevel: parsed.LOG_LEVEL,
    healthPort: parsed.HEALTH_PORT,
  };
}

@Global()
@Module({})
export class WorkerConfigModule {
  static forRoot(options: WorkerConfigOptions = {}): DynamicModule {
    return {
      module: WorkerConfigModule,
      imports: [
        ConfigModule.forRoot({
          ...(options.envFilePath && { envFilePath: options.envFilePath }),
          isGlobal: true,
        }),
      ],
      providers: [
        {
          provide: WORKER_CONFIG,
          useFactory: validateAndTransform,
        },
      ],
      exports: [WORKER_CONFIG],
    };
  }
}
