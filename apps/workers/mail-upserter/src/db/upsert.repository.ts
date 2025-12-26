import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { DB_POOL } from "./database.module.js";

export const UPSERT_REPOSITORY = "UPSERT_REPOSITORY";

export interface EmbeddingWithMetadata {
	embedding_id: string;
	email_id: string;
	chunk_id: string;
	chunk_hash: string;
	embedding_model: string;
	embedding_version: string;
	vector_dim: number;
	vector_data: Buffer;
	embedded_at: Date;
	// From email table
	tenant_id: string;
	account_id: string;
	section_type: string | null;
	received_at: Date | null;
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
	 * Fetch embedding with full metadata for Milvus upsert
	 */
	async getEmbeddingWithMetadata(
		emailId: string,
		chunkHash: string,
		embeddingVersion: string,
	): Promise<EmbeddingWithMetadata | null> {
		const result = await this.pool.query<EmbeddingWithMetadata>(
			`SELECT
				ee.embedding_id,
				ee.email_id,
				ee.chunk_id,
				ee.chunk_hash,
				ee.embedding_model,
				ee.embedding_version,
				ee.vector_dim,
				ee.vector_data,
				ee.embedded_at,
				e.tenant_id,
				e.account_id,
				ec.section_type,
				e.received_at
			FROM email_embedding ee
			JOIN email e ON ee.email_id = e.id
			LEFT JOIN email_chunk ec ON ee.chunk_id = ec.chunk_id
			WHERE ee.email_id = $1
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
	 * Check if vector already exists in Milvus (by checking vector_id in email_chunk)
	 */
	async vectorExists(
		emailId: string,
		chunkHash: string,
		embeddingVersion: string,
	): Promise<boolean> {
		const result = await this.pool.query<{ count: string }>(
			`SELECT COUNT(*) as count
			FROM email_chunk
			WHERE email_id = $1
				AND chunk_hash = $2
				AND embedding_version = $3
				AND vector_id IS NOT NULL`,
			[emailId, chunkHash, embeddingVersion],
		);

		return Number.parseInt(result.rows[0]?.count ?? "0", 10) > 0;
	}

	/**
	 * Update email_chunk with Milvus vector_id after successful upsert
	 */
	async updateVectorId(
		chunkId: string,
		vectorId: string,
		embeddingVersion: string,
	): Promise<void> {
		await this.pool.query(
			`UPDATE email_chunk
			SET vector_id = $1, upserted_at = NOW(), embedding_version = $2
			WHERE chunk_id = $3`,
			[vectorId, embeddingVersion, chunkId],
		);

		this.logger.debug("Vector ID updated", {
			chunk_id: chunkId,
			vector_id: vectorId,
		});
	}

	/**
	 * Update multiple chunks with vector IDs in a transaction
	 */
	async updateVectorIds(
		updates: Array<{
			chunkId: string;
			vectorId: string;
			embeddingVersion: string;
		}>,
	): Promise<void> {
		if (updates.length === 0) return;

		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");

			for (const update of updates) {
				await client.query(
					`UPDATE email_chunk
					SET vector_id = $1, upserted_at = NOW(), embedding_version = $2
					WHERE chunk_id = $3`,
					[update.vectorId, update.embeddingVersion, update.chunkId],
				);
			}

			await client.query("COMMIT");

			this.logger.debug("Vector IDs batch updated", {
				count: updates.length,
			});
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	/**
	 * Get section type for a chunk
	 */
	async getChunkSectionType(chunkId: string): Promise<string | null> {
		const result = await this.pool.query<{ section_type: string | null }>(
			"SELECT section_type FROM email_chunk WHERE chunk_id = $1",
			[chunkId],
		);

		return result.rows[0]?.section_type ?? null;
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
