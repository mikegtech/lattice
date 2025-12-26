import type {
	MailDeleteCompletedPayload,
	MailDeleteRequestPayload,
} from "@lattice/core-contracts";
import {
	BaseWorkerService,
	type KafkaService,
	type LoggerService,
	type TelemetryService,
	type WorkerConfig,
	type WorkerContext,
	classifyError,
} from "@lattice/worker-base";
import { Injectable } from "@nestjs/common";
import type {
	DeletionRepository,
	DeletionStats,
} from "../db/deletion.repository.js";
import type { DeleteResult, MilvusService } from "../milvus/milvus.service.js";

export interface DeletionResult {
	emails_deleted: number;
	chunks_deleted: number;
	embeddings_deleted: number;
	vectors_deleted: number;
	storage_deleted: number;
}

@Injectable()
export class MailDeleterService extends BaseWorkerService<
	MailDeleteRequestPayload,
	MailDeleteCompletedPayload
> {
	constructor(
		kafka: KafkaService,
		telemetry: TelemetryService,
		logger: LoggerService,
		config: WorkerConfig,
		private readonly deletionRepository: DeletionRepository,
		private readonly milvusService: MilvusService,
	) {
		super(kafka, telemetry, logger, config);
	}

	protected async process(
		payload: MailDeleteRequestPayload,
		context: WorkerContext,
	): Promise<
		| { status: "success"; output: MailDeleteCompletedPayload }
		| { status: "skip"; reason: string }
		| { status: "retry"; reason: string }
		| { status: "dlq"; reason: string; error: Error }
	> {
		const logContext: Record<string, unknown> = {
			request_id: payload.request_id,
			request_type: payload.request_type,
			tenant_id: payload.tenant_id,
			account_id: payload.account_id,
			stage: "delete",
		};
		if (context.traceId) logContext["trace_id"] = context.traceId;

		this.logger.info("Processing deletion request", logContext);
		this.telemetry.increment("deletion.requests.received", 1, {
			request_type: payload.request_type,
		});

		const startedAt = new Date();

		try {
			// Step 1: Validate required fields
			const validationError = this.validatePayload(payload);
			if (validationError) {
				this.telemetry.increment("deletion.requests.error", 1, {
					error_code: "validation_failed",
				});
				return {
					status: "dlq",
					reason: validationError,
					error: new Error(validationError),
				};
			}

			// Step 2: Upsert deletion request (idempotent)
			const { isNew, record } =
				await this.deletionRepository.upsertDeletionRequest(payload);

			if (!isNew) {
				// Check if already completed
				if (record.status === "completed") {
					this.logger.info("Deletion request already completed, skipping", {
						...logContext,
						completed_at: record.completed_at,
					});
					this.telemetry.increment("deletion.requests.skipped", 1, {
						reason: "already_completed",
					});
					return {
						status: "skip",
						reason: "Deletion request already completed",
					};
				}

				// If failed, retry
				if (record.status === "failed") {
					this.logger.info("Retrying previously failed deletion", {
						...logContext,
						last_error: record.last_error,
					});
				}
			}

			// Step 3: Mark as in progress
			await this.deletionRepository.markInProgress(payload.request_id);

			// Step 4: Resolve affected emails
			const emailsToDelete =
				await this.deletionRepository.getEmailsToDelete(payload);

			this.logger.info("Resolved emails to delete", {
				...logContext,
				email_count: emailsToDelete.length,
			});

			if (emailsToDelete.length === 0) {
				// Nothing to delete - mark as completed
				const completedPayload = this.buildCompletedPayload(
					payload,
					startedAt,
					{
						emails_deleted: 0,
						chunks_deleted: 0,
						embeddings_deleted: 0,
						vectors_deleted: 0,
						storage_deleted: 0,
					},
				);

				await this.deletionRepository.markCompleted(payload.request_id, {
					emails_deleted: 0,
					chunks_deleted: 0,
					embeddings_deleted: 0,
					vectors_deleted: 0,
					storage_deleted: 0,
				});

				this.telemetry.increment("deletion.requests.success", 1, {
					request_type: payload.request_type,
				});
				this.logger.info("No emails found to delete", logContext);

				return { status: "success", output: completedPayload };
			}

			const emailIds = emailsToDelete.map((e) => e.id);
			const stats: DeletionResult = {
				emails_deleted: 0,
				chunks_deleted: 0,
				embeddings_deleted: 0,
				vectors_deleted: 0,
				storage_deleted: 0,
			};

			// Step 5: Delete from Milvus (if enabled)
			if (payload.delete_vectors) {
				const milvusResult = await this.deleteFromMilvus(
					payload,
					emailIds,
					logContext,
				);
				stats.vectors_deleted = milvusResult.deleted;

				if (milvusResult.errors.length > 0) {
					this.logger.warn("Partial Milvus deletion errors", {
						...logContext,
						errors: milvusResult.errors,
					});
				}
			}

			// Step 6: Delete from Postgres (FK-safe order)
			if (payload.delete_postgres) {
				const dbStats = await this.deletionRepository.deleteEmailData(
					emailIds,
					payload.deletion_type === "hard",
				);
				stats.emails_deleted = dbStats.emails_deleted;
				stats.chunks_deleted = dbStats.chunks_deleted;
				stats.embeddings_deleted = dbStats.embeddings_deleted;
			}

			// Step 7: Delete from object storage (if enabled)
			if (payload.delete_storage) {
				// TODO: Implement object storage deletion
				// For now, log a warning that this is not yet implemented
				this.logger.warn(
					"Object storage deletion not yet implemented",
					logContext,
				);
				stats.storage_deleted = 0;
			}

			// Step 8: Mark completed
			await this.deletionRepository.markCompleted(payload.request_id, stats);

			const completedPayload = this.buildCompletedPayload(
				payload,
				startedAt,
				stats,
			);

			this.telemetry.increment("deletion.requests.success", 1, {
				request_type: payload.request_type,
			});
			this.telemetry.gauge("deletion.emails_deleted", stats.emails_deleted);
			this.telemetry.gauge("deletion.vectors_deleted", stats.vectors_deleted);

			this.logger.info("Deletion completed successfully", {
				...logContext,
				...stats,
				duration_ms: completedPayload.duration_ms,
			});

			return { status: "success", output: completedPayload };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.telemetry.increment("deletion.requests.error", 1, {
				error_code: "process_failed",
			});

			this.logger.error(
				"Failed to process deletion request",
				err.stack,
				JSON.stringify(logContext),
			);

			// Mark as failed in ledger
			try {
				await this.deletionRepository.markFailed(
					payload.request_id,
					err.message,
				);
			} catch (markError) {
				this.logger.error(
					"Failed to mark deletion as failed",
					markError instanceof Error ? markError.stack : String(markError),
					JSON.stringify(logContext),
				);
			}

			const classification = classifyError(err);
			if (classification === "retryable") {
				return { status: "retry", reason: err.message };
			}

			return { status: "dlq", reason: err.message, error: err };
		}
	}

	private validatePayload(payload: MailDeleteRequestPayload): string | null {
		if (!payload.request_id) {
			return "Missing required field: request_id";
		}
		if (!payload.request_type) {
			return "Missing required field: request_type";
		}
		if (!payload.tenant_id) {
			return "Missing required field: tenant_id";
		}
		if (!payload.account_id) {
			return "Missing required field: account_id";
		}
		if (!payload.deletion_type) {
			return "Missing required field: deletion_type";
		}
		if (!payload.deletion_reason) {
			return "Missing required field: deletion_reason";
		}
		if (!payload.requested_at) {
			return "Missing required field: requested_at";
		}

		// Validate request-type specific fields
		switch (payload.request_type) {
			case "single_email":
				if (!payload.email_id) {
					return "Missing required field for single_email: email_id";
				}
				break;
			case "alias":
				if (!payload.alias) {
					return "Missing required field for alias deletion: alias";
				}
				break;
			case "retention_sweep":
				if (!payload.cutoff_date) {
					return "Missing required field for retention_sweep: cutoff_date";
				}
				break;
			case "account":
				// No additional fields required
				break;
			default:
				return `Unknown request_type: ${payload.request_type}`;
		}

		return null;
	}

	private async deleteFromMilvus(
		payload: MailDeleteRequestPayload,
		emailIds: string[],
		logContext: Record<string, unknown>,
	): Promise<DeleteResult> {
		this.logger.debug("Deleting from Milvus", {
			...logContext,
			email_count: emailIds.length,
			method: payload.request_type,
		});

		const startTime = Date.now();

		try {
			let result: DeleteResult;

			// Choose deletion strategy based on request type
			switch (payload.request_type) {
				case "single_email":
					result = await this.milvusService.deleteByEmailIds(emailIds);
					break;

				case "account":
					result = await this.milvusService.deleteByAccount(
						payload.tenant_id,
						payload.account_id,
					);
					break;

				case "alias":
					result = await this.milvusService.deleteByAlias(
						payload.tenant_id,
						payload.account_id,
						payload.alias!,
					);
					break;

				case "retention_sweep":
					// For retention sweep, delete by email IDs
					result = await this.milvusService.deleteByEmailIds(emailIds);
					break;

				default:
					result = await this.milvusService.deleteByEmailIds(emailIds);
			}

			this.telemetry.timing("deletion.milvus_ms", Date.now() - startTime, {
				request_type: payload.request_type,
			});

			return result;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.logger.error(
				"Milvus deletion failed",
				err.stack,
				JSON.stringify(logContext),
			);
			return {
				deleted: 0,
				errors: [err.message],
			};
		}
	}

	private buildCompletedPayload(
		request: MailDeleteRequestPayload,
		startedAt: Date,
		stats: DeletionResult,
	): MailDeleteCompletedPayload {
		const completedAt = new Date();
		return {
			request_id: request.request_id,
			request_type: request.request_type,
			tenant_id: request.tenant_id,
			account_id: request.account_id,
			emails_deleted: stats.emails_deleted,
			chunks_deleted: stats.chunks_deleted,
			embeddings_deleted: stats.embeddings_deleted,
			vectors_deleted: stats.vectors_deleted,
			storage_objects_deleted: stats.storage_deleted,
			started_at: startedAt.toISOString(),
			completed_at: completedAt.toISOString(),
			duration_ms: completedAt.getTime() - startedAt.getTime(),
		};
	}
}
