import type { Kafka, Producer, Message as KafkaMessage, RecordMetadata } from 'kafkajs';
import type { Logger } from '@lattice/core-telemetry';
import { injectTraceContext } from '@lattice/core-telemetry';
import type { Envelope } from './envelope.js';
import type { TopicName } from './topics.js';

export interface ProduceOptions {
  /** Partition key (defaults to account_id from envelope) */
  key?: string;
  /** Additional headers */
  headers?: Record<string, string>;
}

export interface LatticeProducer {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send<T>(
    topic: TopicName | string,
    envelope: Envelope<T>,
    options?: ProduceOptions
  ): Promise<RecordMetadata[]>;
  sendBatch<T>(
    messages: Array<{
      topic: TopicName | string;
      envelope: Envelope<T>;
      options?: ProduceOptions;
    }>
  ): Promise<RecordMetadata[]>;
}

interface ProducerOptions {
  kafka: Kafka;
  logger: Logger;
  serviceName: string;
  serviceVersion: string;
}

class LatticeProducerImpl implements LatticeProducer {
  private producer: Producer;
  private logger: Logger;
  private serviceName: string;
  private serviceVersion: string;
  private connected = false;

  constructor(options: ProducerOptions) {
    this.producer = options.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 5,
    });
    this.logger = options.logger;
    this.serviceName = options.serviceName;
    this.serviceVersion = options.serviceVersion;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.producer.connect();
    this.connected = true;
    this.logger.info('Kafka producer connected');
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.producer.disconnect();
    this.connected = false;
    this.logger.info('Kafka producer disconnected');
  }

  async send<T>(
    topic: string,
    envelope: Envelope<T>,
    options?: ProduceOptions
  ): Promise<RecordMetadata[]> {
    const traceContext = injectTraceContext();

    const headers: Record<string, string> = {
      'x-lattice-service': this.serviceName,
      'x-lattice-version': this.serviceVersion,
      'x-lattice-schema-version': envelope.schema_version,
      'x-lattice-message-id': envelope.message_id,
      ...(traceContext.trace_id && { 'x-datadog-trace-id': traceContext.trace_id }),
      ...(traceContext.span_id && { 'x-datadog-parent-id': traceContext.span_id }),
      ...options?.headers,
    };

    const message: KafkaMessage = {
      key: options?.key ?? envelope.account_id,
      value: JSON.stringify(envelope),
      headers,
    };

    const result = await this.producer.send({
      topic,
      messages: [message],
    });

    this.logger.debug('Message sent', {
      topic,
      message_id: envelope.message_id,
      account_id: envelope.account_id,
      stage: envelope.stage,
      ...(traceContext.trace_id && { trace_id: traceContext.trace_id }),
    });

    return result;
  }

  async sendBatch<T>(
    messages: Array<{
      topic: string;
      envelope: Envelope<T>;
      options?: ProduceOptions;
    }>
  ): Promise<RecordMetadata[]> {
    const traceContext = injectTraceContext();

    const topicMessages = new Map<string, KafkaMessage[]>();

    for (const { topic, envelope, options } of messages) {
      const headers: Record<string, string> = {
        'x-lattice-service': this.serviceName,
        'x-lattice-version': this.serviceVersion,
        'x-lattice-schema-version': envelope.schema_version,
        'x-lattice-message-id': envelope.message_id,
        ...(traceContext.trace_id && { 'x-datadog-trace-id': traceContext.trace_id }),
        ...(traceContext.span_id && { 'x-datadog-parent-id': traceContext.span_id }),
        ...options?.headers,
      };

      const kafkaMessage: KafkaMessage = {
        key: options?.key ?? envelope.account_id,
        value: JSON.stringify(envelope),
        headers,
      };

      const existing = topicMessages.get(topic) ?? [];
      existing.push(kafkaMessage);
      topicMessages.set(topic, existing);
    }

    const result = await this.producer.sendBatch({
      topicMessages: Array.from(topicMessages.entries()).map(([topic, messages]) => ({
        topic,
        messages,
      })),
    });

    this.logger.debug('Batch sent', {
      message_count: messages.length,
      topic_count: topicMessages.size,
    });

    return result;
  }
}

export function createProducer(options: ProducerOptions): LatticeProducer {
  return new LatticeProducerImpl(options);
}
