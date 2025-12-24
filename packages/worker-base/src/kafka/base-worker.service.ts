import { Injectable, OnApplicationBootstrap, Inject } from '@nestjs/common';
import { KafkaService, type KafkaMessage, type ProcessResult } from './kafka.service.js';
import { TelemetryService } from '../telemetry/telemetry.service.js';
import { LoggerService, LOGGER } from '../telemetry/logger.service.js';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module.js';

export interface WorkerContext {
  traceId?: string;
  spanId?: string;
  topic: string;
  partition: number;
  offset: string;
}

export type WorkerHandler<TIn, TOut = void> = (
  payload: TIn,
  context: WorkerContext,
) => Promise<
  | { status: 'success'; output?: TOut }
  | { status: 'skip'; reason: string }
  | { status: 'retry'; reason: string }
  | { status: 'dlq'; reason: string; error: Error }
>;

/**
 * Base class for Kafka worker services.
 * Extend this class and implement the `process` method.
 */
@Injectable()
export abstract class BaseWorkerService<TIn, TOut = void>
  implements OnApplicationBootstrap
{
  constructor(
    protected readonly kafka: KafkaService,
    protected readonly telemetry: TelemetryService,
    @Inject(LOGGER) protected readonly logger: LoggerService,
    @Inject(WORKER_CONFIG) protected readonly config: WorkerConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.info('Worker service starting', {
      service: this.config.service,
      topic_in: this.config.kafka.topicIn,
    });

    await this.kafka.run<TIn>(this.handleMessage.bind(this));
  }

  /**
   * Implement this method to process incoming messages.
   * The envelope is already validated and parsed.
   */
  protected abstract process(
    payload: TIn,
    context: WorkerContext,
  ): Promise<
    | { status: 'success'; output?: TOut }
    | { status: 'skip'; reason: string }
    | { status: 'retry'; reason: string }
    | { status: 'dlq'; reason: string; error: Error }
  >;

  /**
   * Override to produce output message after successful processing.
   * Only called when process returns success with output.
   */
  protected async produceOutput(
    output: TOut,
    originalMessage: KafkaMessage<TIn>,
  ): Promise<void> {
    const topicOut = this.config.kafka.topicOut;
    if (!topicOut) {
      return;
    }

    await this.kafka.produce(topicOut, output, {
      tenantId: originalMessage.envelope.tenant_id,
      accountId: originalMessage.envelope.account_id,
      domain: originalMessage.envelope.domain,
      stage: this.config.stage,
      schemaVersion: 'v1',
    });
  }

  private async handleMessage(message: KafkaMessage<TIn>): Promise<ProcessResult> {
    const context: WorkerContext = {
      topic: message.topic,
      partition: message.partition,
      offset: message.offset,
    };
    if (message.traceId) context.traceId = message.traceId;
    if (message.spanId) context.spanId = message.spanId;

    const result = await this.telemetry.withSpan(
      `${this.config.service}.process`,
      { stage: this.config.stage },
      async () => this.process(message.envelope.payload, context),
    );

    if (result.status === 'success' && result.output !== undefined) {
      await this.produceOutput(result.output, message);
    }

    // Map internal result to KafkaService result
    switch (result.status) {
      case 'success':
        return { status: 'success' };
      case 'skip':
        return { status: 'skip', reason: result.reason };
      case 'retry':
        return { status: 'retry', reason: result.reason };
      case 'dlq':
        return { status: 'dlq', reason: result.reason, error: result.error };
    }
  }
}
