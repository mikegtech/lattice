import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { DB_POOL } from "./database.module.js";

export interface ExtractedAttachment {
	attachment_id: string;
	extracted_text: string;
	mime_type: string;
	filename: string;
}

export interface EmailMetadata {
	email_id: string;
	account_id: string;
	provider_message_id: string;
	content_hash: string;
}

export const ATTACHMENT_REPOSITORY = Symbol("ATTACHMENT_REPOSITORY");

@Injectable()
export class AttachmentRepository {
	constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

	async getExtractedText(
		emailId: string,
		attachmentId: string,
	): Promise<ExtractedAttachment | null> {
		const result = await this.pool.query<ExtractedAttachment>(
			`SELECT attachment_id, extracted_text, mime_type, filename
			 FROM email_attachment
			 WHERE email_id = $1 AND attachment_id = $2
				 AND extraction_status = 'success'
				 AND extracted_text IS NOT NULL`,
			[emailId, attachmentId],
		);
		return result.rows[0] ?? null;
	}

	async getEmailMetadata(emailId: string): Promise<EmailMetadata | null> {
		const result = await this.pool.query<EmailMetadata>(
			`SELECT id as email_id, account_id, provider_message_id, content_hash
			 FROM email
			 WHERE id = $1`,
			[emailId],
		);
		return result.rows[0] ?? null;
	}
}
