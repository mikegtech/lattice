import type { ChunkSourceType, SectionType } from "@lattice/core-contracts";
import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { DB_POOL } from "./database.module.js";

export const CHUNK_REPOSITORY = Symbol("CHUNK_REPOSITORY");

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

@Injectable()
export class ChunkRepository {
	constructor(
		@Inject(DB_POOL) private readonly pool: pg.Pool,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

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

			this.logger.debug("Attachment chunks inserted", {
				email_id: chunks[0]?.email_id,
				attachment_id: chunks[0]?.attachment_id,
				chunk_count: chunks.length,
			});
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
}
