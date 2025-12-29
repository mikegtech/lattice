import type { MailParsePayload, MailRawPayload } from "@lattice/core-contracts";
import {
	BaseWorkerService,
	type KafkaService,
	type LoggerService,
	type TelemetryService,
	type WorkerConfig,
	type WorkerContext,
	classifyError,
} from "@lattice/worker-base";
import { Injectable } from "@nestjs/common";
import type {
	AttachmentRecord,
	EmailRecord,
	EmailRepository,
} from "../db/email.repository.js";
import type { EnvelopeContext, ParserService } from "./parser.service.js";

@Injectable()
export class MailParserService extends BaseWorkerService<
	MailRawPayload,
	MailParsePayload
> {
	constructor(
		kafka: KafkaService,
		telemetry: TelemetryService,
		logger: LoggerService,
		config: WorkerConfig,
		private readonly emailRepository: EmailRepository,
		private readonly parser: ParserService,
	) {
		super(kafka, telemetry, logger, config);
	}

	protected async process(
		payload: MailRawPayload,
		context: WorkerContext,
	): Promise<
		| { status: "success"; output: MailParsePayload }
		| { status: "skip"; reason: string }
		| { status: "retry"; reason: string }
		| { status: "dlq"; reason: string; error: Error }
	> {
		const logContext: Record<string, unknown> = {
			provider_message_id: payload.provider_message_id,
			email_id: payload.email_id,
			stage: "parse",
		};
		if (context.traceId) logContext["trace_id"] = context.traceId;

		this.logger.info(
			"Processing raw email",
			logContext as import("@lattice/worker-base").LoggerService extends {
				info(m: string, c?: infer C): void;
			}
				? C
				: never,
		);
		this.telemetry.increment("messages.received", 1, { stage: "parse" });

		try {
			// Get envelope data from the Kafka message context
			const tenantId = context.envelope?.tenant_id ?? "default";
			const accountId =
				context.envelope?.account_id ??
				payload.email_id.split("-")[0] ??
				"unknown";
			const alias = context.envelope?.alias ?? "inbox";
			const provider = context.envelope?.provider ?? "gmail";

			// Build envelope context for parser
			const envelopeContext: EnvelopeContext = {
				tenant_id: tenantId,
				account_id: accountId,
				alias,
				provider,
			};

			// Check for existing email
			const existing = await this.emailRepository.findByProviderMessageId(
				accountId,
				payload.provider_message_id,
			);

			// Parse the email (includes claim check and attachment storage)
			const {
				payload: parsedPayload,
				contentHash,
				extractableAttachments,
			} = await this.parser.parse(payload, envelopeContext);

			// Idempotency check
			if (existing && existing.content_hash === contentHash) {
				this.logger.info(
					"Email already processed with same content, skipping",
					{
						...logContext,
						existing_id: existing.id,
						content_hash: contentHash,
					} as Record<string, unknown>,
				);
				this.telemetry.increment("messages.skipped", 1, {
					stage: "parse",
					reason: "duplicate",
				});
				return { status: "skip", reason: "Duplicate content hash" };
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
			if (payload.raw_object_uri)
				emailRecord.raw_object_uri = payload.raw_object_uri;
			if (payload.size_bytes) emailRecord.size_bytes = payload.size_bytes;
			if (parsedPayload.body.text_plain)
				emailRecord.text_body = parsedPayload.body.text_plain;
			if (parsedPayload.body.text_html)
				emailRecord.html_body = parsedPayload.body.text_html;
			if (parsedPayload.body.text_normalized)
				emailRecord.text_normalized = parsedPayload.body.text_normalized;

			// Build attachment records
			const attachmentRecords: AttachmentRecord[] =
				parsedPayload.attachments.map((att) => {
					const rec: AttachmentRecord = {
						email_id: payload.email_id,
						attachment_id: att.attachment_id,
						content_hash: att.content_hash,
						filename: att.filename,
						mime_type: att.mime_type,
						size_bytes: att.size_bytes,
						extraction_status: att.extraction_status ?? "pending",
					};
					if (att.storage_uri) rec.storage_uri = att.storage_uri;
					if (att.extracted_text) rec.extracted_text = att.extracted_text;
					return rec;
				});

			// Upsert to database
			const startDb = Date.now();
			const emailId = await this.emailRepository.upsertEmail(emailRecord);
			await this.emailRepository.upsertAttachments(emailId, attachmentRecords);
			this.telemetry.timing("db.upsert_ms", Date.now() - startDb, {
				stage: "parse",
			});

			// Emit attachment extraction requests for extractable attachments
			if (extractableAttachments.length > 0) {
				// Get attachment topic from config (with sensible fallback)
				const attachmentTopic =
					this.config.kafka.topicAttachment ?? "lattice.mail.attachment.v1";
				for (const att of extractableAttachments) {
					await this.kafka.produce(
						attachmentTopic,
						{
							email_id: att.email_id,
							attachment_id: att.attachment_id,
							storage_uri: att.storage_uri,
							mime_type: att.mime_type,
							filename: att.filename,
							size_bytes: att.size_bytes,
						},
						{
							tenantId,
							accountId,
							domain: "mail",
							stage: "extract", // Destined for mail-extractor worker
							schemaVersion: "v1",
						},
					);

					this.logger.debug("Emitted attachment extraction request", {
						email_id: att.email_id,
						attachment_id: att.attachment_id,
						mime_type: att.mime_type,
					});
				}

				this.telemetry.increment(
					"attachments.extraction_requested",
					extractableAttachments.length,
					{
						stage: "parse",
					},
				);
			}

			this.telemetry.increment("messages.success", 1, { stage: "parse" });
			this.logger.info("Email parsed and stored", {
				...logContext,
				attachment_count: parsedPayload.attachments.length,
				extractable_count: extractableAttachments.length,
				content_hash: contentHash,
				is_update: !!existing,
			} as Record<string, unknown>);

			return { status: "success", output: parsedPayload };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.telemetry.increment("messages.error", 1, { stage: "parse" });

			this.logger.error(
				"Failed to parse email",
				err.stack,
				JSON.stringify(logContext),
			);

			const classification = classifyError(err);
			if (classification === "retryable") {
				return { status: "retry", reason: err.message };
			}

			return { status: "dlq", reason: err.message, error: err };
		}
	}
}
