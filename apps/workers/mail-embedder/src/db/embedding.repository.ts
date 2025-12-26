import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { DB_POOL } from "./database.module.js";

export const EMBEDDING_REPOSITORY = "EMBEDDING_REPOSITORY";

export interface EmbeddingRecord {
	embedding_id: string;
	email_id: string;
	chunk_id: string;
	chunk_hash: string;
	embedding_model: string;
	embedding_version: string;
	vector_dim: number;
	vector_data: Buffer;
	embedded_at: Date;
}

export interface ChunkContent {
	chunk_id: string;
	email_id: string;
	chunk_hash: string;
	chunk_text: string;
}

@Injectable()
export class EmbeddingRepository {
	constructor(
		@Inject(DB_POOL) private readonly pool: pg.Pool,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	/**
	 * Check if embedding already exists for this chunk with the given version.
	 * Used for idempotency check.
	 */
	async embeddingExists(
		emailId: string,
		chunkHash: string,
		embeddingVersion: string,
	): Promise<boolean> {
		const result = await this.pool.query<{ count: string }>(
			`SELECT COUNT(*) as count
       FROM email_embedding
       WHERE email_id = $1
         AND chunk_hash = $2
         AND embedding_version = $3`,
			[emailId, chunkHash, embeddingVersion],
		);

		return Number.parseInt(result.rows[0]?.count ?? "0", 10) > 0;
	}

	/**
	 * Check if embeddings exist for multiple chunks (batch idempotency check)
	 */
	async getExistingEmbeddings(
		emailId: string,
		chunkHashes: string[],
		embeddingVersion: string,
	): Promise<Set<string>> {
		if (chunkHashes.length === 0) {
			return new Set();
		}

		const result = await this.pool.query<{ chunk_hash: string }>(
			`SELECT chunk_hash
       FROM email_embedding
       WHERE email_id = $1
         AND chunk_hash = ANY($2)
         AND embedding_version = $3`,
			[emailId, chunkHashes, embeddingVersion],
		);

		return new Set(result.rows.map((r) => r.chunk_hash));
	}

	/**
	 * Fetch chunk content from Postgres by chunk_id
	 */
	async getChunkContent(chunkId: string): Promise<ChunkContent | null> {
		const result = await this.pool.query<ChunkContent>(
			`SELECT chunk_id, email_id, chunk_hash, chunk_text
       FROM email_chunk
       WHERE chunk_id = $1`,
			[chunkId],
		);

		return result.rows[0] ?? null;
	}

	/**
	 * Fetch multiple chunks by IDs
	 */
	async getChunkContents(chunkIds: string[]): Promise<ChunkContent[]> {
		if (chunkIds.length === 0) {
			return [];
		}

		const result = await this.pool.query<ChunkContent>(
			`SELECT chunk_id, email_id, chunk_hash, chunk_text
       FROM email_chunk
       WHERE chunk_id = ANY($1)`,
			[chunkIds],
		);

		return result.rows;
	}

	/**
	 * Insert an embedding record with vector data
	 */
	async insertEmbedding(record: EmbeddingRecord): Promise<void> {
		await this.pool.query(
			`INSERT INTO email_embedding (
        embedding_id, email_id, chunk_id, chunk_hash,
        embedding_model, embedding_version, vector_dim,
        vector_data, embedded_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (email_id, chunk_hash, embedding_version)
      DO UPDATE SET
        embedding_id = EXCLUDED.embedding_id,
        embedding_model = EXCLUDED.embedding_model,
        vector_dim = EXCLUDED.vector_dim,
        vector_data = EXCLUDED.vector_data,
        embedded_at = EXCLUDED.embedded_at`,
			[
				record.embedding_id,
				record.email_id,
				record.chunk_id,
				record.chunk_hash,
				record.embedding_model,
				record.embedding_version,
				record.vector_dim,
				record.vector_data,
				record.embedded_at,
			],
		);

		this.logger.debug("Embedding inserted", {
			embedding_id: record.embedding_id,
			email_id: record.email_id,
			chunk_id: record.chunk_id,
		});
	}

	/**
	 * Insert multiple embeddings in a transaction
	 */
	async insertEmbeddings(records: EmbeddingRecord[]): Promise<void> {
		if (records.length === 0) return;

		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");

			for (const record of records) {
				await client.query(
					`INSERT INTO email_embedding (
            embedding_id, email_id, chunk_id, chunk_hash,
            embedding_model, embedding_version, vector_dim,
            vector_data, embedded_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (email_id, chunk_hash, embedding_version)
          DO UPDATE SET
            embedding_id = EXCLUDED.embedding_id,
            embedding_model = EXCLUDED.embedding_model,
            vector_dim = EXCLUDED.vector_dim,
            vector_data = EXCLUDED.vector_data,
            embedded_at = EXCLUDED.embedded_at`,
					[
						record.embedding_id,
						record.email_id,
						record.chunk_id,
						record.chunk_hash,
						record.embedding_model,
						record.embedding_version,
						record.vector_dim,
						record.vector_data,
						record.embedded_at,
					],
				);
			}

			await client.query("COMMIT");

			this.logger.debug("Embeddings batch inserted", {
				count: records.length,
				email_id: records[0]?.email_id,
			});
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	/**
	 * Get embedding by ID
	 */
	async getEmbedding(embeddingId: string): Promise<EmbeddingRecord | null> {
		const result = await this.pool.query<EmbeddingRecord>(
			`SELECT embedding_id, email_id, chunk_id, chunk_hash,
              embedding_model, embedding_version, vector_dim,
              vector_data, embedded_at
       FROM email_embedding
       WHERE embedding_id = $1`,
			[embeddingId],
		);

		return result.rows[0] ?? null;
	}

	/**
	 * Convert float32 array to Buffer for storage
	 */
	static vectorToBuffer(vector: number[]): Buffer {
		const buffer = Buffer.alloc(vector.length * 4);
		for (let i = 0; i < vector.length; i++) {
			buffer.writeFloatLE(vector[i] ?? 0, i * 4);
		}
		return buffer;
	}

	/**
	 * Convert Buffer back to float32 array
	 */
	static bufferToVector(buffer: Buffer): number[] {
		const vector: number[] = [];
		for (let i = 0; i < buffer.length; i += 4) {
			vector.push(buffer.readFloatLE(i));
		}
		return vector;
	}
}
