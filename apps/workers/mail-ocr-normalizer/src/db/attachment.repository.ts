import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { DB_POOL } from "./database.module.js";

export const ATTACHMENT_REPOSITORY = Symbol("ATTACHMENT_REPOSITORY");

export interface AttachmentUpdateResult {
	updated: boolean;
	emailId: string;
	attachmentId: string;
}

@Injectable()
export class AttachmentRepository {
	constructor(
		@Inject(DB_POOL) private readonly pool: pg.Pool,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	/**
	 * Update attachment with extracted text from OCR
	 */
	async updateExtractedText(
		emailId: string,
		attachmentId: string,
		extractedText: string,
	): Promise<AttachmentUpdateResult> {
		const client = await this.pool.connect();
		try {
			const result = await client.query(
				`UPDATE email_attachment
				 SET
					extracted_text = $1,
					extraction_status = 'success',
					extracted_at = NOW(),
					extraction_attempts = COALESCE(extraction_attempts, 0) + 1,
					last_extraction_attempt = NOW()
				 WHERE email_id = $2 AND attachment_id = $3
				 RETURNING email_id, attachment_id`,
				[extractedText, emailId, attachmentId],
			);

			const updated = result.rowCount !== null && result.rowCount > 0;

			if (updated) {
				this.logger.debug("Updated attachment with OCR text", {
					email_id: emailId,
					attachment_id: attachmentId,
					text_length: extractedText.length,
				});
			} else {
				this.logger.warn("Attachment not found for OCR update", {
					email_id: emailId,
					attachment_id: attachmentId,
				});
			}

			return {
				updated,
				emailId,
				attachmentId,
			};
		} finally {
			client.release();
		}
	}
}
