import type { MailDeleteRequestPayload } from "@lattice/core-contracts";
import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { DB_POOL } from "./database.module.js";

export const DELETION_REPOSITORY = "DELETION_REPOSITORY";

export type DeletionStatus = "pending" | "in_progress" | "completed" | "failed";

export interface DeletionRequestRecord {
	id: string;
	requested_at: Date;
	tenant_id: string;
	account_id: string;
	request_type: string;
	request_json: Record<string, unknown>;
	status: DeletionStatus;
	emails_deleted: number;
	chunks_deleted: number;
	embeddings_deleted: number;
	vectors_deleted: number;
	storage_deleted: number;
	started_at: Date | null;
	completed_at: Date | null;
	last_error: string | null;
}

export interface EmailToDelete {
	id: string;
	provider_message_id: string;
	tenant_id: string;
	account_id: string;
}

export interface ChunkToDelete {
	chunk_id: string;
	email_id: string;
	chunk_hash: string;
	vector_id: string | null;
}

export interface DeletionStats {
	emails_deleted: number;
	chunks_deleted: number;
	embeddings_deleted: number;
}

@Injectable()
export class DeletionRepository {
	constructor(
		@Inject(DB_POOL) private readonly pool: pg.Pool,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	/**
	 * Get existing deletion request (for idempotency check)
	 */
	async getDeletionRequest(
		requestId: string,
	): Promise<DeletionRequestRecord | null> {
		const result = await this.pool.query<DeletionRequestRecord>(
			"SELECT * FROM deletion_request WHERE id = $1",
			[requestId],
		);
		return result.rows[0] ?? null;
	}

	/**
	 * Create or update deletion request (idempotent)
	 * Returns true if newly created, false if already exists
	 */
	async upsertDeletionRequest(
		payload: MailDeleteRequestPayload,
	): Promise<{ isNew: boolean; record: DeletionRequestRecord }> {
		const existing = await this.getDeletionRequest(payload.request_id);

		if (existing) {
			return { isNew: false, record: existing };
		}

		const result = await this.pool.query<DeletionRequestRecord>(
			`INSERT INTO deletion_request (
				id, requested_at, tenant_id, account_id, request_type, request_json, status
			) VALUES ($1, $2, $3, $4, $5, $6, 'pending')
			ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
			RETURNING *`,
			[
				payload.request_id,
				new Date(payload.requested_at),
				payload.tenant_id,
				payload.account_id,
				payload.request_type,
				JSON.stringify(payload),
			],
		);

		return { isNew: true, record: result.rows[0]! };
	}

	/**
	 * Mark deletion as in progress
	 */
	async markInProgress(requestId: string): Promise<void> {
		await this.pool.query(
			`UPDATE deletion_request
			 SET status = 'in_progress', started_at = NOW(), updated_at = NOW()
			 WHERE id = $1`,
			[requestId],
		);
	}

	/**
	 * Mark deletion as completed with stats
	 */
	async markCompleted(
		requestId: string,
		stats: {
			emails_deleted: number;
			chunks_deleted: number;
			embeddings_deleted: number;
			vectors_deleted: number;
			storage_deleted: number;
		},
	): Promise<void> {
		await this.pool.query(
			`UPDATE deletion_request
			 SET status = 'completed',
			     completed_at = NOW(),
			     updated_at = NOW(),
			     emails_deleted = $2,
			     chunks_deleted = $3,
			     embeddings_deleted = $4,
			     vectors_deleted = $5,
			     storage_deleted = $6
			 WHERE id = $1`,
			[
				requestId,
				stats.emails_deleted,
				stats.chunks_deleted,
				stats.embeddings_deleted,
				stats.vectors_deleted,
				stats.storage_deleted,
			],
		);
	}

	/**
	 * Mark deletion as failed
	 */
	async markFailed(requestId: string, error: string): Promise<void> {
		await this.pool.query(
			`UPDATE deletion_request
			 SET status = 'failed', last_error = $2, updated_at = NOW()
			 WHERE id = $1`,
			[requestId, error],
		);
	}

	/**
	 * Get emails to delete based on request type
	 */
	async getEmailsToDelete(
		payload: MailDeleteRequestPayload,
	): Promise<EmailToDelete[]> {
		let query: string;
		let params: unknown[];

		switch (payload.request_type) {
			case "single_email":
				query = `SELECT id, provider_message_id, tenant_id, account_id
				         FROM email
				         WHERE id = $1 AND deleted_at IS NULL`;
				params = [payload.email_id];
				break;

			case "account":
				query = `SELECT id, provider_message_id, tenant_id, account_id
				         FROM email
				         WHERE tenant_id = $1 AND account_id = $2 AND deleted_at IS NULL`;
				params = [payload.tenant_id, payload.account_id];
				break;

			case "alias":
				query = `SELECT e.id, e.provider_message_id, e.tenant_id, e.account_id
				         FROM email e
				         JOIN mail_accounts ma ON e.tenant_id = ma.tenant_id AND e.account_id = ma.account_id
				         WHERE e.tenant_id = $1 AND e.account_id = $2 AND ma.alias = $3 AND e.deleted_at IS NULL`;
				params = [payload.tenant_id, payload.account_id, payload.alias];
				break;

			case "retention_sweep":
				query = `SELECT id, provider_message_id, tenant_id, account_id
				         FROM email
				         WHERE tenant_id = $1 AND account_id = $2
				           AND received_at < $3 AND deleted_at IS NULL`;
				params = [
					payload.tenant_id,
					payload.account_id,
					new Date(payload.cutoff_date!),
				];
				break;

			default:
				return [];
		}

		const result = await this.pool.query<EmailToDelete>(query, params);
		return result.rows;
	}

	/**
	 * Get chunks for a list of email IDs
	 */
	async getChunksForEmails(emailIds: string[]): Promise<ChunkToDelete[]> {
		if (emailIds.length === 0) return [];

		const result = await this.pool.query<ChunkToDelete>(
			`SELECT chunk_id, email_id, chunk_hash, vector_id
			 FROM email_chunk
			 WHERE email_id = ANY($1)`,
			[emailIds],
		);
		return result.rows;
	}

	/**
	 * Delete embeddings for given email IDs
	 */
	async deleteEmbeddings(emailIds: string[]): Promise<number> {
		if (emailIds.length === 0) return 0;

		const result = await this.pool.query(
			"DELETE FROM email_embedding WHERE email_id = ANY($1)",
			[emailIds],
		);
		return result.rowCount ?? 0;
	}

	/**
	 * Delete chunks for given email IDs
	 */
	async deleteChunks(emailIds: string[]): Promise<number> {
		if (emailIds.length === 0) return 0;

		const result = await this.pool.query(
			"DELETE FROM email_chunk WHERE email_id = ANY($1)",
			[emailIds],
		);
		return result.rowCount ?? 0;
	}

	/**
	 * Hard delete emails
	 */
	async deleteEmails(emailIds: string[]): Promise<number> {
		if (emailIds.length === 0) return 0;

		const result = await this.pool.query(
			"DELETE FROM email WHERE id = ANY($1)",
			[emailIds],
		);
		return result.rowCount ?? 0;
	}

	/**
	 * Soft delete emails (mark as deleted)
	 */
	async softDeleteEmails(emailIds: string[]): Promise<number> {
		if (emailIds.length === 0) return 0;

		const result = await this.pool.query(
			"UPDATE email SET deleted_at = NOW() WHERE id = ANY($1) AND deleted_at IS NULL",
			[emailIds],
		);
		return result.rowCount ?? 0;
	}

	/**
	 * Delete all data for emails in a transaction (FK-safe order)
	 */
	async deleteEmailData(
		emailIds: string[],
		hardDelete: boolean,
	): Promise<DeletionStats> {
		if (emailIds.length === 0) {
			return { emails_deleted: 0, chunks_deleted: 0, embeddings_deleted: 0 };
		}

		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");

			// Delete in FK-safe order: embeddings -> chunks -> emails
			const embeddingsResult = await client.query(
				"DELETE FROM email_embedding WHERE email_id = ANY($1)",
				[emailIds],
			);

			const chunksResult = await client.query(
				"DELETE FROM email_chunk WHERE email_id = ANY($1)",
				[emailIds],
			);

			let emailsResult: pg.QueryResult;
			if (hardDelete) {
				emailsResult = await client.query(
					"DELETE FROM email WHERE id = ANY($1)",
					[emailIds],
				);
			} else {
				emailsResult = await client.query(
					"UPDATE email SET deleted_at = NOW() WHERE id = ANY($1) AND deleted_at IS NULL",
					[emailIds],
				);
			}

			await client.query("COMMIT");

			this.logger.debug("Deleted email data", {
				email_count: emailIds.length,
				embeddings_deleted: embeddingsResult.rowCount,
				chunks_deleted: chunksResult.rowCount,
				emails_deleted: emailsResult.rowCount,
			});

			return {
				emails_deleted: emailsResult.rowCount ?? 0,
				chunks_deleted: chunksResult.rowCount ?? 0,
				embeddings_deleted: embeddingsResult.rowCount ?? 0,
			};
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
}
