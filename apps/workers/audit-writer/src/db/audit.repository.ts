import { createHash } from "node:crypto";
import type { AuditEventPayload } from "@lattice/core-contracts";
import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { DB_POOL } from "./database.module.js";

export const AUDIT_REPOSITORY = "AUDIT_REPOSITORY";

/**
 * Fields that should NEVER be stored in audit logs (secrets/PII)
 */
const FORBIDDEN_FIELDS = new Set([
	"access_token",
	"refresh_token",
	"token",
	"password",
	"secret",
	"api_key",
	"apiKey",
	"authorization",
	"cookie",
	"session",
	"raw_body",
	"body_html",
	"body_text",
	"raw_email",
	"raw_content",
]);

/**
 * Maximum size for JSON payload (prevent storing huge payloads)
 */
const MAX_PAYLOAD_SIZE = 64 * 1024; // 64KB

export interface AuditEventRecord {
	id: string;
	occurred_at: Date;
	tenant_id: string | null;
	account_id: string | null;
	alias: string | null;
	provider: string | null;
	event_type: string;
	stage: string | null;
	entity_type: string | null;
	entity_id: string | null;
	correlation_id: string | null;
	payload_json: Record<string, unknown>;
}

@Injectable()
export class AuditRepository {
	constructor(
		@Inject(DB_POOL) private readonly pool: pg.Pool,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	/**
	 * Generate deterministic ID for idempotency
	 * Based on: event_type + entity_id + occurred_at + correlation_id
	 */
	static generateEventId(payload: AuditEventPayload): string {
		// If audit_id is provided, use it directly
		if (payload.audit_id) {
			return payload.audit_id;
		}

		// Generate deterministic ID from key fields
		const input = [
			payload.event_type,
			payload.entity_id ?? "",
			payload.timestamp,
			payload.correlation?.trace_id ?? "",
		].join(":");

		return createHash("sha256").update(input).digest("hex").substring(0, 36);
	}

	/**
	 * Sanitize payload - remove secrets and PII
	 */
	static sanitizePayload(
		payload: Record<string, unknown>,
	): Record<string, unknown> {
		const sanitized: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(payload)) {
			// Skip forbidden fields
			if (FORBIDDEN_FIELDS.has(key.toLowerCase())) {
				sanitized[key] = "[REDACTED]";
				continue;
			}

			// Recursively sanitize nested objects
			if (value && typeof value === "object" && !Array.isArray(value)) {
				sanitized[key] = AuditRepository.sanitizePayload(
					value as Record<string, unknown>,
				);
			} else if (Array.isArray(value)) {
				sanitized[key] = value.map((item) =>
					item && typeof item === "object"
						? AuditRepository.sanitizePayload(item as Record<string, unknown>)
						: item,
				);
			} else {
				sanitized[key] = value;
			}
		}

		return sanitized;
	}

	/**
	 * Check if audit event already exists (idempotency)
	 */
	async eventExists(eventId: string): Promise<boolean> {
		const result = await this.pool.query<{ exists: boolean }>(
			"SELECT EXISTS(SELECT 1 FROM audit_event WHERE id = $1) as exists",
			[eventId],
		);
		return result.rows[0]?.exists ?? false;
	}

	/**
	 * Insert audit event with idempotency check
	 * Returns true if inserted, false if duplicate
	 */
	async insertEvent(payload: AuditEventPayload): Promise<boolean> {
		const eventId = AuditRepository.generateEventId(payload);

		// Build sanitized payload JSON
		const payloadJson = AuditRepository.sanitizePayload({
			action: payload.action,
			outcome: payload.outcome,
			details: payload.details,
			metrics: payload.metrics,
			actor: payload.actor,
			provider_message_id: payload.provider_message_id,
			email_id: payload.email_id,
		});

		// Check payload size
		const payloadStr = JSON.stringify(payloadJson);
		if (payloadStr.length > MAX_PAYLOAD_SIZE) {
			this.logger.warn("Audit payload too large, truncating details", {
				event_id: eventId,
				size: payloadStr.length,
				max_size: MAX_PAYLOAD_SIZE,
			});
			// Remove details if too large
			payloadJson["details"] = undefined;
		}

		try {
			await this.pool.query(
				`INSERT INTO audit_event (
					id, occurred_at, tenant_id, account_id, alias, provider,
					event_type, stage, entity_type, entity_id, correlation_id, payload_json
				) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
				ON CONFLICT (id) DO NOTHING`,
				[
					eventId,
					new Date(payload.timestamp),
					payload.actor.service.includes("gmail") ? "default" : null, // Extract tenant from context if available
					null, // account_id - would come from envelope context
					null, // alias
					payload.provider_message_id ? "gmail" : null,
					payload.event_type,
					payload.actor.service.split("-").pop() ?? null, // Extract stage from service name
					payload.entity_type,
					payload.entity_id ?? payload.email_id,
					payload.correlation?.trace_id ?? null,
					payloadJson,
				],
			);

			return true;
		} catch (error) {
			// Check for duplicate key error (concurrent insert)
			if (
				error instanceof Error &&
				error.message.includes("duplicate key value")
			) {
				this.logger.debug("Duplicate audit event, skipping", {
					event_id: eventId,
				});
				return false;
			}
			throw error;
		}
	}

	/**
	 * Insert audit event with full context from envelope
	 */
	async insertEventWithContext(
		payload: AuditEventPayload,
		context: {
			tenantId?: string;
			accountId?: string;
			alias?: string;
			provider?: string;
			stage?: string;
		},
	): Promise<boolean> {
		const eventId = AuditRepository.generateEventId(payload);

		const payloadJson = AuditRepository.sanitizePayload({
			action: payload.action,
			outcome: payload.outcome,
			details: payload.details,
			metrics: payload.metrics,
			actor: payload.actor,
			provider_message_id: payload.provider_message_id,
			email_id: payload.email_id,
		});

		const payloadStr = JSON.stringify(payloadJson);
		if (payloadStr.length > MAX_PAYLOAD_SIZE) {
			this.logger.warn("Audit payload too large, truncating", {
				event_id: eventId,
			});
			payloadJson["details"] = undefined;
		}

		try {
			const result = await this.pool.query(
				`INSERT INTO audit_event (
					id, occurred_at, tenant_id, account_id, alias, provider,
					event_type, stage, entity_type, entity_id, correlation_id, payload_json
				) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
				ON CONFLICT (id) DO NOTHING
				RETURNING id`,
				[
					eventId,
					new Date(payload.timestamp),
					context.tenantId ?? null,
					context.accountId ?? null,
					context.alias ?? null,
					context.provider ?? null,
					payload.event_type,
					context.stage ?? null,
					payload.entity_type,
					payload.entity_id ?? payload.email_id,
					payload.correlation?.trace_id ?? null,
					payloadJson,
				],
			);

			return result.rowCount !== null && result.rowCount > 0;
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.includes("duplicate key value")
			) {
				return false;
			}
			throw error;
		}
	}

	/**
	 * Query audit events by entity
	 */
	async getEventsByEntity(
		entityType: string,
		entityId: string,
		limit = 100,
	): Promise<AuditEventRecord[]> {
		const result = await this.pool.query<AuditEventRecord>(
			`SELECT * FROM audit_event
			 WHERE entity_type = $1 AND entity_id = $2
			 ORDER BY occurred_at DESC
			 LIMIT $3`,
			[entityType, entityId, limit],
		);
		return result.rows;
	}

	/**
	 * Query audit events by account
	 */
	async getEventsByAccount(
		tenantId: string,
		accountId: string,
		limit = 100,
	): Promise<AuditEventRecord[]> {
		const result = await this.pool.query<AuditEventRecord>(
			`SELECT * FROM audit_event
			 WHERE tenant_id = $1 AND account_id = $2
			 ORDER BY occurred_at DESC
			 LIMIT $3`,
			[tenantId, accountId, limit],
		);
		return result.rows;
	}
}
