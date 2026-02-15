import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { DB_POOL } from "./database.module.js";

export const UPSERT_REPOSITORY = "UPSERT_REPOSITORY";

export interface EmbeddingWithMetadata {
	chunk_id: string;
	chunk_hash: string;
	embedding_version: string;
	embedding_model: string;
	vector_data: Buffer;
	section_type: string | null;
	chunk_text: string;
}

export interface EmailMetadata {
	tenant_id: string;
	account_id: string;
	alias: string | null;
	received_at: Date | null;
}

@Injectable()
export class UpsertRepository {
	constructor(
		@Inject(DB_POOL) private readonly pool: pg.Pool,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	/**
	 * Fetch embedding with metadata for ES indexing.
	 * Includes chunk_text for full-text search in Elasticsearch.
	 */
	async getEmbeddingWithMetadata(
		emailId: string,
		chunkHash: string,
		embeddingVersion: string,
	): Promise<EmbeddingWithMetadata | null> {
		const result = await this.pool.query<EmbeddingWithMetadata>(
			`SELECT ee.chunk_id, ee.chunk_hash, ee.embedding_version,
				ee.embedding_model, ee.vector_data, ec.section_type,
				ec.chunk_text
			FROM email_embedding ee
			JOIN email_chunk ec ON ee.chunk_id = ec.chunk_id
			WHERE ec.email_id = $1
				AND ee.chunk_hash = $2
				AND ee.embedding_version = $3`,
			[emailId, chunkHash, embeddingVersion],
		);

		return result.rows[0] ?? null;
	}

	/**
	 * Get email metadata for a given email_id
	 */
	async getEmailMetadata(emailId: string): Promise<EmailMetadata | null> {
		const result = await this.pool.query<EmailMetadata>(
			`SELECT
				e.tenant_id,
				e.account_id,
				ma.alias,
				e.received_at
			FROM email e
			LEFT JOIN mail_accounts ma ON e.tenant_id = ma.tenant_id AND e.account_id = ma.account_id
			WHERE e.id = $1`,
			[emailId],
		);

		return result.rows[0] ?? null;
	}

	/**
	 * Convert Buffer to float32 array
	 */
	static bufferToVector(buffer: Buffer): number[] {
		const vector: number[] = [];
		for (let i = 0; i < buffer.length; i += 4) {
			vector.push(buffer.readFloatLE(i));
		}
		return vector;
	}
}
