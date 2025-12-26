import type { AuditEventPayload } from "@lattice/core-contracts";
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
import {
	AuditRepository,
	type AuditRepository as AuditRepositoryType,
} from "../db/audit.repository.js";

@Injectable()
export class AuditWriterService extends BaseWorkerService<
	AuditEventPayload,
	void
> {
	constructor(
		kafka: KafkaService,
		telemetry: TelemetryService,
		logger: LoggerService,
		config: WorkerConfig,
		private readonly auditRepository: AuditRepositoryType,
	) {
		super(kafka, telemetry, logger, config);
	}

	protected async process(
		payload: AuditEventPayload,
		context: WorkerContext,
	): Promise<
		| { status: "success"; output: undefined }
		| { status: "skip"; reason: string }
		| { status: "retry"; reason: string }
		| { status: "dlq"; reason: string; error: Error }
	> {
		const eventId = AuditRepository.generateEventId(payload);
		const logContext: Record<string, unknown> = {
			audit_id: eventId,
			event_type: payload.event_type,
			entity_type: payload.entity_type,
			entity_id: payload.entity_id,
			stage: "audit",
		};
		if (context.traceId) logContext["trace_id"] = context.traceId;

		this.logger.debug("Processing audit event", logContext);
		this.telemetry.increment("audit.events.received", 1, {
			event_type: payload.event_type,
		});

		try {
			// Validate required fields
			if (!payload.event_type) {
				this.telemetry.increment("audit.events.error", 1, {
					error_code: "missing_event_type",
				});
				return {
					status: "dlq",
					reason: "Missing required field: event_type",
					error: new Error("Missing required field: event_type"),
				};
			}

			if (!payload.timestamp) {
				this.telemetry.increment("audit.events.error", 1, {
					error_code: "missing_timestamp",
				});
				return {
					status: "dlq",
					reason: "Missing required field: timestamp",
					error: new Error("Missing required field: timestamp"),
				};
			}

			if (!payload.actor) {
				this.telemetry.increment("audit.events.error", 1, {
					error_code: "missing_actor",
				});
				return {
					status: "dlq",
					reason: "Missing required field: actor",
					error: new Error("Missing required field: actor"),
				};
			}

			// Check for idempotency - if event exists, skip
			const exists = await this.auditRepository.eventExists(eventId);
			if (exists) {
				this.logger.debug("Audit event already exists, skipping", {
					...logContext,
					audit_id: eventId,
				});
				this.telemetry.increment("audit.events.skipped", 1, {
					reason: "duplicate",
				});
				return {
					status: "skip",
					reason: "Audit event already exists",
				};
			}

			// Extract context from envelope if available
			const eventContext = {
				tenantId: undefined as string | undefined,
				accountId: undefined as string | undefined,
				alias: undefined as string | undefined,
				provider: payload.provider_message_id ? "gmail" : undefined,
				stage: payload.actor.service.split("-").pop(),
			};

			// Insert with context
			const inserted = await this.auditRepository.insertEventWithContext(
				payload,
				eventContext,
			);

			if (!inserted) {
				// Concurrent insert - treat as skip
				this.telemetry.increment("audit.events.skipped", 1, {
					reason: "concurrent_duplicate",
				});
				return {
					status: "skip",
					reason: "Concurrent duplicate insert",
				};
			}

			this.telemetry.increment("audit.events.success", 1, {
				event_type: payload.event_type,
			});
			this.logger.info("Audit event written successfully", {
				...logContext,
				outcome: payload.outcome,
			});

			return { status: "success", output: undefined };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.telemetry.increment("audit.events.error", 1, {
				error_code: "write_failed",
			});

			this.logger.error(
				"Failed to write audit event",
				err.stack,
				JSON.stringify(logContext),
			);

			const classification = classifyError(err);
			if (classification === "retryable") {
				return { status: "retry", reason: err.message };
			}

			return { status: "dlq", reason: err.message, error: err };
		}
	}
}
