import type {
  Kafka,
  Consumer,
  EachMessagePayload,
  KafkaMessage,
} from 'kafkajs';
import type { Logger } from '@lattice/core-telemetry';
import { extractTraceContext } from '@lattice/core-telemetry';
import type { Envelope } from './envelope.js';
import { validateEnvelope } from './envelope.js';
import type { TopicName } from './topics.js';
import { RetryableError, NonRetryableError, SchemaValidationError } from './errors.js';
import type { DLQPublisher } from './dlq.js';

export type ProcessResult =
  | { status: 'success' }
  | { status: 'skip'; reason: string }
  | { status: 'retry'; reason: string; delay?: number }
  | { status: 'dlq'; reason: string; error: Error };

export type MessageHandler<T> = (
  envelope: Envelope<T>,
  context: MessageContext
) => Promise<ProcessResult>;

export interface MessageContext {
  topic: string;
  partition: number;
  offset: string;
  timestamp: string;
  headers: Record<string, string | undefined>;
  trace_id?: string;
  span_id?: string;
  logger: Logger;
}

export interface ConsumerOptions {
  kafka: Kafka;
  logger: Logger;
  groupId: string;
  topics: Array<TopicName | string>;
  dlqPublisher?: DLQPublisher;
  expectedSchemaVersion?: string;
  maxRetries?: number;
  retryBackoffMs?: number;
  sessionTimeout?: number;
  heartbeatInterval?: number;
}

export interface LatticeConsumer {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(): Promise<void>;
  run<T>(handler: MessageHandler<T>): Promise<void>;
  pause(): void;
  resume(): void;
}

class LatticeConsumerImpl implements LatticeConsumer {
  private consumer: Consumer;
  private logger: Logger;
  private topics: string[];
  private dlqPublisher?: DLQPublisher;
  private expectedSchemaVersion?: string;
  private maxRetries: number;
  private retryBackoffMs: number;
  private connected = false;
  private running = false;
  private paused = false;

  constructor(options: ConsumerOptions) {
    this.consumer = options.kafka.consumer({
      groupId: options.groupId,
      sessionTimeout: options.sessionTimeout ?? 30000,
      heartbeatInterval: options.heartbeatInterval ?? 3000,
      maxBytesPerPartition: 1048576, // 1MB
      retry: {
        retries: options.maxRetries ?? 5,
      },
    });
    this.logger = options.logger;
    this.topics = options.topics;
    this.dlqPublisher = options.dlqPublisher;
    this.expectedSchemaVersion = options.expectedSchemaVersion;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBackoffMs = options.retryBackoffMs ?? 1000;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.consumer.connect();
    this.connected = true;
    this.logger.info('Kafka consumer connected');
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.consumer.disconnect();
    this.connected = false;
    this.running = false;
    this.logger.info('Kafka consumer disconnected');
  }

  async subscribe(): Promise<void> {
    for (const topic of this.topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }
    this.logger.info('Subscribed to topics', { topics: this.topics });
  }

  pause(): void {
    if (this.paused) return;
    this.consumer.pause(this.topics.map((topic) => ({ topic })));
    this.paused = true;
    this.logger.info('Consumer paused');
  }

  resume(): void {
    if (!this.paused) return;
    this.consumer.resume(this.topics.map((topic) => ({ topic })));
    this.paused = false;
    this.logger.info('Consumer resumed');
  }

  async run<T>(handler: MessageHandler<T>): Promise<void> {
    if (this.running) {
      throw new Error('Consumer already running');
    }
    this.running = true;

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        await this.handleMessage(payload, handler);
      },
    });
  }

  private async handleMessage<T>(
    payload: EachMessagePayload,
    handler: MessageHandler<T>
  ): Promise<void> {
    const { topic, partition, message } = payload;
    const startTime = Date.now();

    // Extract headers
    const headers = this.extractHeaders(message);
    const traceContext = extractTraceContext(headers as Record<string, string | Buffer | undefined>);

    const context: MessageContext = {
      topic,
      partition,
      offset: message.offset,
      timestamp: message.timestamp,
      headers,
      trace_id: traceContext.trace_id,
      span_id: traceContext.span_id,
      logger: this.logger.child({
        topic,
        partition,
        offset: message.offset,
        trace_id: traceContext.trace_id,
      }),
    };

    try {
      // Parse and validate envelope
      const rawValue = message.value?.toString();
      if (!rawValue) {
        context.logger.warn('Empty message received, skipping');
        return;
      }

      const parsed = JSON.parse(rawValue);
      const envelope = validateEnvelope(parsed, this.expectedSchemaVersion);

      // Process with retries
      const result = await this.processWithRetries(
        envelope as Envelope<T>,
        context,
        handler
      );

      const duration = Date.now() - startTime;

      switch (result.status) {
        case 'success':
          context.logger.info('Message processed successfully', {
            duration_ms: duration,
            message_id: envelope.message_id,
          });
          break;

        case 'skip':
          context.logger.info('Message skipped', {
            reason: result.reason,
            message_id: envelope.message_id,
          });
          break;

        case 'dlq':
          await this.sendToDLQ(envelope, context, result.error, 'non_retryable');
          break;
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      if (error instanceof SchemaValidationError) {
        context.logger.error('Schema validation failed', {
          error_code: error.code,
          validation_errors: error.validationErrors,
        });
        // Send raw message to DLQ
        await this.sendRawToDLQ(message, context, err, 'poison');
      } else {
        context.logger.error('Unexpected error processing message', {
          error_message: err.message,
          error_stack: err.stack,
        });
        await this.sendRawToDLQ(message, context, err, 'non_retryable');
      }
    }
  }

  private extractHeaders(message: KafkaMessage): Record<string, string | undefined> {
    const headers: Record<string, string | undefined> = {};
    if (message.headers) {
      for (const [key, value] of Object.entries(message.headers)) {
        headers[key] = value?.toString();
      }
    }
    return headers;
  }

  private async processWithRetries<T>(
    envelope: Envelope<T>,
    context: MessageContext,
    handler: MessageHandler<T>
  ): Promise<ProcessResult> {
    let lastError: Error | undefined;
    let retryCount = 0;

    while (retryCount <= this.maxRetries) {
      try {
        const result = await handler(envelope, context);

        if (result.status === 'retry') {
          if (retryCount >= this.maxRetries) {
            return {
              status: 'dlq',
              reason: `Max retries exceeded: ${result.reason}`,
              error: lastError ?? new Error(result.reason),
            };
          }

          const delay = result.delay ?? this.retryBackoffMs * Math.pow(2, retryCount);
          context.logger.warn('Retrying message', {
            retry_count: retryCount + 1,
            max_retries: this.maxRetries,
            delay_ms: delay,
            reason: result.reason,
          });

          await this.sleep(delay);
          retryCount++;
          continue;
        }

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof NonRetryableError) {
          return {
            status: 'dlq',
            reason: error.message,
            error,
          };
        }

        if (error instanceof RetryableError && retryCount < this.maxRetries) {
          const delay = this.retryBackoffMs * Math.pow(2, retryCount);
          context.logger.warn('Retrying after error', {
            retry_count: retryCount + 1,
            max_retries: this.maxRetries,
            delay_ms: delay,
            error_message: error.message,
          });
          await this.sleep(delay);
          retryCount++;
          continue;
        }

        return {
          status: 'dlq',
          reason: `Processing failed: ${lastError.message}`,
          error: lastError,
        };
      }
    }

    return {
      status: 'dlq',
      reason: 'Max retries exceeded',
      error: lastError ?? new Error('Unknown error'),
    };
  }

  private async sendToDLQ(
    envelope: Envelope,
    context: MessageContext,
    error: Error,
    classification: 'retryable' | 'non_retryable' | 'poison'
  ): Promise<void> {
    if (!this.dlqPublisher) {
      context.logger.error('No DLQ publisher configured, message dropped', {
        message_id: envelope.message_id,
        error_message: error.message,
      });
      return;
    }

    await this.dlqPublisher.publish({
      originalTopic: context.topic,
      originalPartition: context.partition,
      originalOffset: context.offset,
      originalMessage: envelope,
      failureStage: envelope.stage,
      errorClassification: classification,
      errorCode: error instanceof RetryableError || error instanceof NonRetryableError
        ? error.code
        : 'UNKNOWN',
      errorMessage: error.message,
      errorStack: error.stack,
      retryCount: this.maxRetries,
      processingService: context.headers['x-lattice-service'] ?? 'unknown',
    });

    context.logger.warn('Message sent to DLQ', {
      message_id: envelope.message_id,
      error_classification: classification,
    });
  }

  private async sendRawToDLQ(
    message: KafkaMessage,
    context: MessageContext,
    error: Error,
    classification: 'retryable' | 'non_retryable' | 'poison'
  ): Promise<void> {
    if (!this.dlqPublisher) {
      context.logger.error('No DLQ publisher configured, message dropped');
      return;
    }

    await this.dlqPublisher.publish({
      originalTopic: context.topic,
      originalPartition: context.partition,
      originalOffset: context.offset,
      originalMessage: {
        key: message.key?.toString(),
        value: message.value?.toString(),
        headers: context.headers,
      },
      failureStage: 'raw',
      errorClassification: classification,
      errorCode: 'PARSE_ERROR',
      errorMessage: error.message,
      errorStack: error.stack,
      retryCount: 0,
      processingService: context.headers['x-lattice-service'] ?? 'unknown',
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function createConsumer(options: ConsumerOptions): LatticeConsumer {
  return new LatticeConsumerImpl(options);
}
