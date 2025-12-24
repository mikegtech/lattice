import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { DB_POOL } from "./database.module.js";

export interface EmailRecord {
	id: string;
	tenant_id: string;
	account_id: string;
	provider_message_id: string;
	thread_id: string;
	content_hash: string;
	subject: string;
	from_address: { name?: string; address: string };
	to_addresses: Array<{ name?: string; address: string }>;
	cc_addresses: Array<{ name?: string; address: string }>;
	bcc_addresses: Array<{ name?: string; address: string }>;
	sent_at: Date;
	received_at: Date;
	fetched_at: Date;
	parsed_at: Date;
	raw_object_uri?: string;
	size_bytes?: number;
	text_body?: string;
	html_body?: string;
	text_normalized?: string;
}

export interface AttachmentRecord {
	email_id: string;
	attachment_id: string;
	content_hash: string;
	filename: string;
	mime_type: string;
	size_bytes: number;
	storage_uri?: string;
	extracted_text?: string;
	extraction_status: "pending" | "success" | "failed" | "unsupported";
}

@Injectable()
export class EmailRepository {
	constructor(
		@Inject(DB_POOL) private readonly pool: pg.Pool,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	async findByProviderMessageId(
		accountId: string,
		providerMessageId: string,
	): Promise<{ id: string; content_hash: string } | null> {
		const result = await this.pool.query<{ id: string; content_hash: string }>(
			`SELECT id, content_hash
       FROM email
       WHERE account_id = $1 AND provider_message_id = $2 AND deletion_status = 'active'`,
			[accountId, providerMessageId],
		);

		return result.rows[0] ?? null;
	}

	async upsertEmail(record: EmailRecord): Promise<string> {
		const result = await this.pool.query<{ id: string }>(
			`INSERT INTO email (
        id, tenant_id, account_id, provider_message_id, thread_id, content_hash,
        subject, from_address, to_addresses, cc_addresses, bcc_addresses,
        sent_at, received_at, fetched_at, parsed_at,
        raw_object_uri, size_bytes, text_body, html_body, text_normalized
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
      )
      ON CONFLICT (account_id, provider_message_id)
      DO UPDATE SET
        content_hash = EXCLUDED.content_hash,
        subject = EXCLUDED.subject,
        from_address = EXCLUDED.from_address,
        to_addresses = EXCLUDED.to_addresses,
        cc_addresses = EXCLUDED.cc_addresses,
        bcc_addresses = EXCLUDED.bcc_addresses,
        text_body = EXCLUDED.text_body,
        html_body = EXCLUDED.html_body,
        text_normalized = EXCLUDED.text_normalized,
        parsed_at = EXCLUDED.parsed_at,
        updated_at = NOW()
      RETURNING id`,
			[
				record.id,
				record.tenant_id,
				record.account_id,
				record.provider_message_id,
				record.thread_id,
				record.content_hash,
				record.subject,
				JSON.stringify(record.from_address),
				JSON.stringify(record.to_addresses),
				JSON.stringify(record.cc_addresses),
				JSON.stringify(record.bcc_addresses),
				record.sent_at,
				record.received_at,
				record.fetched_at,
				record.parsed_at,
				record.raw_object_uri,
				record.size_bytes,
				record.text_body,
				record.html_body,
				record.text_normalized,
			],
		);

		const id = result.rows[0]?.id;
		if (!id) {
			throw new Error("Failed to upsert email - no ID returned");
		}

		this.logger.debug("Email upserted", {
			email_id: id,
			provider_message_id: record.provider_message_id,
		});

		return id;
	}

	async upsertAttachments(
		emailId: string,
		attachments: AttachmentRecord[],
	): Promise<void> {
		if (attachments.length === 0) return;

		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");

			await client.query("DELETE FROM email_attachment WHERE email_id = $1", [
				emailId,
			]);

			for (const att of attachments) {
				await client.query(
					`INSERT INTO email_attachment (
            email_id, attachment_id, content_hash, filename, mime_type,
            size_bytes, storage_uri, extracted_text, extraction_status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
					[
						emailId,
						att.attachment_id,
						att.content_hash,
						att.filename,
						att.mime_type,
						att.size_bytes,
						att.storage_uri,
						att.extracted_text,
						att.extraction_status,
					],
				);
			}

			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
}
