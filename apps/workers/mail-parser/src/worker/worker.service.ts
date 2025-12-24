import { Injectable, Inject } from '@nestjs/common';
import {
  BaseWorkerService,
  KafkaService,
  TelemetryService,
  LoggerService,
  LOGGER,
  WORKER_CONFIG,
  type WorkerConfig,
  type WorkerContext,
  classifyError,
} from '@lattice/worker-base';
import type { MailRawPayload, MailParsePayload } from '@lattice/core-contracts';
import { EmailRepository, type EmailRecord, type AttachmentRecord } from '../db/email.repository.js';
import { ParserService } from './parser.service.js';

@Injectable()
export class MailParserService extends BaseWorkerService<MailRawPayload, MailParsePayload> {
  constructor(
    kafka: KafkaService,
    telemetry: TelemetryService,
    @Inject(LOGGER) logger: LoggerService,
    @Inject(WORKER_CONFIG) config: WorkerConfig,
    private readonly emailRepository: EmailRepository,
    private readonly parser: ParserService,
  ) {
    super(kafka, telemetry, logger, config);
  }

  protected async process(
    payload: MailRawPayload,
    context: WorkerContext,
  ): Promise<
    | { status: 'success'; output: MailParsePayload }
    | { status: 'skip'; reason: string }
    | { status: 'retry'; reason: string }
    | { status: 'dlq'; reason: string; error: Error }
  > {
    const logContext: Record<string, unknown> = {
      provider_message_id: payload.provider_message_id,
      email_id: payload.email_id,
      stage: 'parse',
    };
    if (context.traceId) logContext['trace_id'] = context.traceId;

    this.logger.info('Processing raw email', logContext as import('@lattice/worker-base').LoggerService extends { info(m: string, c?: infer C): void } ? C : never);
    this.telemetry.increment('messages.received', 1, { stage: 'parse' });

    try {
      // Get envelope data from the Kafka message
      // Note: In the base worker, we pass the full envelope's tenant_id and account_id
      // For now, we'll extract these from the payload/topic context
      const accountId = payload.email_id.split('-')[0] ?? 'unknown'; // Will be improved
      const tenantId = 'default';

      // Check for existing email
      const existing = await this.emailRepository.findByProviderMessageId(
        accountId,
        payload.provider_message_id,
      );

      // Parse the email
      const { payload: parsedPayload, contentHash } = await this.parser.parse(payload);

      // Idempotency check
      if (existing && existing.content_hash === contentHash) {
        this.logger.info('Email already processed with same content, skipping', {
          ...logContext,
          existing_id: existing.id,
          content_hash: contentHash,
        } as Record<string, unknown>);
        this.telemetry.increment('messages.skipped', 1, { stage: 'parse', reason: 'duplicate' });
        return { status: 'skip', reason: 'Duplicate content hash' };
      }

      // Build email record
      const emailRecord: EmailRecord = {
        id: payload.email_id,
        tenant_id: tenantId,
        account_id: accountId,
        provider_message_id: payload.provider_message_id,
        thread_id: payload.thread_id,
        content_hash: contentHash,
        subject: parsedPayload.headers.subject,
        from_address: parsedPayload.headers.from,
        to_addresses: parsedPayload.headers.to ?? [],
        cc_addresses: parsedPayload.headers.cc ?? [],
        bcc_addresses: parsedPayload.headers.bcc ?? [],
        sent_at: new Date(parsedPayload.headers.date),
        received_at: new Date(payload.internal_date),
        fetched_at: new Date(payload.fetched_at),
        parsed_at: new Date(),
      };
      if (payload.raw_object_uri) emailRecord.raw_object_uri = payload.raw_object_uri;
      if (payload.size_bytes) emailRecord.size_bytes = payload.size_bytes;
      if (parsedPayload.body.text_plain) emailRecord.text_body = parsedPayload.body.text_plain;
      if (parsedPayload.body.text_html) emailRecord.html_body = parsedPayload.body.text_html;
      if (parsedPayload.body.text_normalized) emailRecord.text_normalized = parsedPayload.body.text_normalized;

      // Build attachment records
      const attachmentRecords: AttachmentRecord[] = parsedPayload.attachments.map((att) => {
        const rec: AttachmentRecord = {
          email_id: payload.email_id,
          attachment_id: att.attachment_id,
          content_hash: att.content_hash,
          filename: att.filename,
          mime_type: att.mime_type,
          size_bytes: att.size_bytes,
          extraction_status: att.extraction_status ?? 'pending',
        };
        if (att.storage_uri) rec.storage_uri = att.storage_uri;
        if (att.extracted_text) rec.extracted_text = att.extracted_text;
        return rec;
      });

      // Upsert to database
      const startDb = Date.now();
      const emailId = await this.emailRepository.upsertEmail(emailRecord);
      await this.emailRepository.upsertAttachments(emailId, attachmentRecords);
      this.telemetry.timing('db.upsert_ms', Date.now() - startDb, { stage: 'parse' });

      this.telemetry.increment('messages.success', 1, { stage: 'parse' });
      this.logger.info('Email parsed and stored', {
        ...logContext,
        attachment_count: parsedPayload.attachments.length,
        content_hash: contentHash,
        is_update: !!existing,
      } as Record<string, unknown>);

      return { status: 'success', output: parsedPayload };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.telemetry.increment('messages.error', 1, { stage: 'parse' });

      this.logger.error('Failed to parse email', err.stack, JSON.stringify(logContext));

      const classification = classifyError(err);
      if (classification === 'retryable') {
        return { status: 'retry', reason: err.message };
      }

      return { status: 'dlq', reason: err.message, error: err };
    }
  }
}
