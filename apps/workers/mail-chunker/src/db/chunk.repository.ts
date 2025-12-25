import type { ChunkSourceType, SectionType } from "@lattice/core-contracts";
import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { DB_POOL } from "./database.module.js";

export const CHUNK_REPOSITORY = "CHUNK_REPOSITORY";

export interface ChunkRecord {
	email_id: string;
	attachment_id?: string;
	chunk_id: string;
	chunk_hash: string;
	chunk_index: number;
	total_chunks: number;
	chunk_text: string;
	char_count: number;
	token_count_estimate?: number;
	source_type: ChunkSourceType;
	section_type?: SectionType;
	chunking_version: string;
	normalization_version: string;
}

export interface EmailContent {
	id: string;
	provider_message_id: string;
	content_hash: string;
	text_normalized: string | null;
	subject: string | null;
}

export interface AttachmentContent {
	attachment_id: string;
	filename: string;
	extracted_text: string | null;
	extraction_status: string;
}

@Injectable()
export class ChunkRepository {
	constructor(
		@Inject(DB_POOL) private readonly pool: pg.Pool,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	/**
	 * Check if chunks already exist for this email with the given versions.
	 * Used for idempotency check.
	 */
	async chunksExist(
		emailId: string,
		chunkingVersion: string,
		normalizationVersion: string,
	): Promise<boolean> {
		const result = await this.pool.query<{ count: string }>(
			`SELECT COUNT(*) as count
       FROM email_chunk
       WHERE email_id = $1
         AND chunking_version = $2
         AND normalization_version = $3`,
			[emailId, chunkingVersion, normalizationVersion],
		);

		return Number.parseInt(result.rows[0]?.count ?? "0", 10) > 0;
	}

	/**
	 * Get existing chunk hashes for this email and versions.
	 * Used for duplicate detection.
	 */
	async getExistingChunkHashes(
		emailId: string,
		chunkingVersion: string,
		normalizationVersion: string,
	): Promise<Set<string>> {
		const result = await this.pool.query<{ chunk_hash: string }>(
			`SELECT chunk_hash
       FROM email_chunk
       WHERE email_id = $1
         AND chunking_version = $2
         AND normalization_version = $3`,
			[emailId, chunkingVersion, normalizationVersion],
		);

		return new Set(result.rows.map((r) => r.chunk_hash));
	}

	/**
	 * Fetch email content from Postgres by email_id
	 */
	async getEmailContent(emailId: string): Promise<EmailContent | null> {
		const result = await this.pool.query<EmailContent>(
			`SELECT id, provider_message_id, content_hash, text_normalized, subject
       FROM email
       WHERE id = $1 AND deletion_status = 'active'`,
			[emailId],
		);

		return result.rows[0] ?? null;
	}

	/**
	 * Fetch attachment extracted text for an email
	 */
	async getAttachmentContents(emailId: string): Promise<AttachmentContent[]> {
		const result = await this.pool.query<AttachmentContent>(
			`SELECT attachment_id, filename, extracted_text, extraction_status
       FROM email_attachment
       WHERE email_id = $1 AND extraction_status = 'success' AND extracted_text IS NOT NULL`,
			[emailId],
		);

		return result.rows;
	}

	/**
	 * Insert chunks in a transaction
	 */
	async insertChunks(chunks: ChunkRecord[]): Promise<void> {
		if (chunks.length === 0) return;

		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");

			for (const chunk of chunks) {
				await client.query(
					`INSERT INTO email_chunk (
            email_id, attachment_id, chunk_id, chunk_hash,
            chunk_index, total_chunks, chunk_text, char_count,
            token_count_estimate, source_type, section_type,
            chunking_version, normalization_version
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (email_id, chunk_hash, chunking_version, normalization_version)
          DO NOTHING`,
					[
						chunk.email_id,
						chunk.attachment_id,
						chunk.chunk_id,
						chunk.chunk_hash,
						chunk.chunk_index,
						chunk.total_chunks,
						chunk.chunk_text,
						chunk.char_count,
						chunk.token_count_estimate,
						chunk.source_type,
						chunk.section_type,
						chunk.chunking_version,
						chunk.normalization_version,
					],
				);
			}

			await client.query("COMMIT");

			this.logger.debug("Chunks inserted", {
				email_id: chunks[0]?.email_id,
				chunk_count: chunks.length,
			});
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	/**
	 * Delete existing chunks for re-chunking with new version
	 */
	async deleteChunks(
		emailId: string,
		chunkingVersion: string,
		normalizationVersion: string,
	): Promise<number> {
		const result = await this.pool.query(
			`DELETE FROM email_chunk
       WHERE email_id = $1
         AND chunking_version = $2
         AND normalization_version = $3`,
			[emailId, chunkingVersion, normalizationVersion],
		);

		return result.rowCount ?? 0;
	}
}
