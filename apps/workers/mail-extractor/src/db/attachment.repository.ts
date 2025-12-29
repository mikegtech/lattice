import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { DB_POOL } from "./database.module.js";

export const ATTACHMENT_REPOSITORY = "ATTACHMENT_REPOSITORY";

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
	 * Update attachment with extracted text and status
	 */
	async updateExtractedText(
		emailId: string,
		attachmentId: string,
		extractedText: string | null,
		extractionStatus: "success" | "failed" | "unsupported",
		extractionError?: string,
	): Promise<AttachmentUpdateResult> {
		const client = await this.pool.connect();
		try {
			const result = await client.query(
				`UPDATE email_attachment
				 SET
					extracted_text = $1,
					extraction_status = $2,
					extraction_error = $3,
					extracted_at = NOW(),
					extraction_attempts = COALESCE(extraction_attempts, 0) + 1,
					last_extraction_attempt = NOW()
				 WHERE email_id = $4 AND attachment_id = $5
				 RETURNING email_id, attachment_id`,
				[
					extractedText,
					extractionStatus,
					extractionError ?? null,
					emailId,
					attachmentId,
				],
			);

			const updated = result.rowCount !== null && result.rowCount > 0;

			if (updated) {
				this.logger.debug("Updated attachment extraction", {
					email_id: emailId,
					attachment_id: attachmentId,
					extraction_status: extractionStatus,
					text_length: extractedText?.length ?? 0,
				});
			} else {
				this.logger.warn("Attachment not found for update", {
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

	/**
	 * Find attachment by ID
	 */
	async findById(
		emailId: string,
		attachmentId: string,
	): Promise<{ storage_uri: string; mime_type: string } | null> {
		const client = await this.pool.connect();
		try {
			const result = await client.query(
				`SELECT storage_uri, mime_type
				 FROM email_attachment
				 WHERE email_id = $1 AND attachment_id = $2`,
				[emailId, attachmentId],
			);

			if (result.rows.length === 0) {
				return null;
			}

			return result.rows[0];
		} finally {
			client.release();
		}
	}
}
