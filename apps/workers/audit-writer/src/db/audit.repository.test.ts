import type { AuditEventPayload } from "@lattice/core-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditRepository } from "./audit.repository.js";

describe("AuditRepository", () => {
	describe("generateEventId", () => {
		it("should use audit_id if provided", () => {
			const payload: AuditEventPayload = {
				audit_id: "custom-audit-id-123",
				event_type: "email.parsed",
				entity_type: "email",
				entity_id: "email-123",
				action: "process",
				outcome: "success",
				actor: { service: "mail-parser" },
				timestamp: "2024-01-15T10:00:00Z",
			};

			const id = AuditRepository.generateEventId(payload);
			expect(id).toBe("custom-audit-id-123");
		});

		it("should generate deterministic ID from key fields", () => {
			const payload: AuditEventPayload = {
				audit_id: "",
				event_type: "email.parsed",
				entity_type: "email",
				entity_id: "email-123",
				action: "process",
				outcome: "success",
				actor: { service: "mail-parser" },
				timestamp: "2024-01-15T10:00:00Z",
				correlation: { trace_id: "trace-abc" },
			};

			const id1 = AuditRepository.generateEventId(payload);
			const id2 = AuditRepository.generateEventId(payload);

			expect(id1).toBe(id2);
			expect(id1).toHaveLength(36);
		});

		it("should generate different IDs for different events", () => {
			const base: AuditEventPayload = {
				audit_id: "",
				event_type: "email.parsed",
				entity_type: "email",
				entity_id: "email-123",
				action: "process",
				outcome: "success",
				actor: { service: "mail-parser" },
				timestamp: "2024-01-15T10:00:00Z",
			};

			const ids = [
				AuditRepository.generateEventId(base),
				AuditRepository.generateEventId({
					...base,
					event_type: "email.chunked",
				}),
				AuditRepository.generateEventId({ ...base, entity_id: "email-456" }),
				AuditRepository.generateEventId({
					...base,
					timestamp: "2024-01-15T11:00:00Z",
				}),
			];

			const uniqueIds = new Set(ids);
			expect(uniqueIds.size).toBe(4);
		});
	});

	describe("sanitizePayload", () => {
		it("should redact forbidden fields", () => {
			const payload = {
				email_id: "email-123",
				access_token: "secret-token-abc",
				refresh_token: "refresh-xyz",
				password: "user-password", // pragma: allowlist secret
				api_key: "api-key-123", // pragma: allowlist secret
			};

			const sanitized = AuditRepository.sanitizePayload(payload);

			expect(sanitized["email_id"]).toBe("email-123");
			expect(sanitized["access_token"]).toBe("[REDACTED]");
			expect(sanitized["refresh_token"]).toBe("[REDACTED]");
			expect(sanitized["password"]).toBe("[REDACTED]");
			expect(sanitized["api_key"]).toBe("[REDACTED]");
		});

		it("should redact nested forbidden fields", () => {
			const payload = {
				user: {
					name: "John",
					token: "secret-token",
					credentials: {
						password: "secret-pass", // pragma: allowlist secret
						api_key: "secret-key", // pragma: allowlist secret
					},
				},
			};

			const sanitized = AuditRepository.sanitizePayload(payload);

			expect((sanitized["user"] as Record<string, unknown>)["name"]).toBe(
				"John",
			);
			expect((sanitized["user"] as Record<string, unknown>)["token"]).toBe(
				"[REDACTED]",
			);
			expect(
				(
					(sanitized["user"] as Record<string, unknown>)[
						"credentials"
					] as Record<string, unknown>
				)["password"],
			).toBe("[REDACTED]");
		});

		it("should redact raw email body fields", () => {
			const payload = {
				email_id: "email-123",
				raw_body: "<html>Full email content...</html>",
				body_html: "<p>HTML body</p>",
				body_text: "Plain text body",
				raw_email: "RFC822 content...",
			};

			const sanitized = AuditRepository.sanitizePayload(payload);

			expect(sanitized["email_id"]).toBe("email-123");
			expect(sanitized["raw_body"]).toBe("[REDACTED]");
			expect(sanitized["body_html"]).toBe("[REDACTED]");
			expect(sanitized["body_text"]).toBe("[REDACTED]");
			expect(sanitized["raw_email"]).toBe("[REDACTED]");
		});

		it("should handle arrays with nested objects", () => {
			const payload = {
				items: [
					{ id: 1, secret: "abc" },
					{ id: 2, token: "xyz" },
				],
			};

			const sanitized = AuditRepository.sanitizePayload(payload);
			const items = sanitized["items"] as Array<Record<string, unknown>>;

			expect(items[0]!["id"]).toBe(1);
			expect(items[0]!["secret"]).toBe("[REDACTED]");
			expect(items[1]!["id"]).toBe(2);
			expect(items[1]!["token"]).toBe("[REDACTED]");
		});

		it("should preserve safe fields", () => {
			const payload = {
				email_id: "email-123",
				provider_message_id: "gmail-456",
				event_type: "email.parsed",
				duration_ms: 150,
				chunk_count: 5,
				metadata: {
					subject: "Test Email",
					from: "sender@example.com",
				},
			};

			const sanitized = AuditRepository.sanitizePayload(payload);

			expect(sanitized["email_id"]).toBe("email-123");
			expect(sanitized["provider_message_id"]).toBe("gmail-456");
			expect(sanitized["event_type"]).toBe("email.parsed");
			expect(sanitized["duration_ms"]).toBe(150);
			expect(sanitized["chunk_count"]).toBe(5);
			expect(
				(sanitized["metadata"] as Record<string, unknown>)["subject"],
			).toBe("Test Email");
		});

		it("should handle null and undefined values", () => {
			const payload = {
				email_id: "email-123",
				optional_field: null,
				another: undefined,
			};

			const sanitized = AuditRepository.sanitizePayload(payload);

			expect(sanitized["email_id"]).toBe("email-123");
			expect(sanitized["optional_field"]).toBeNull();
			expect(sanitized["another"]).toBeUndefined();
		});
	});
});

describe("AuditRepository integration", () => {
	let mockPool: {
		query: ReturnType<typeof vi.fn>;
	};
	let mockLogger: {
		info: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
		debug: ReturnType<typeof vi.fn>;
		error: ReturnType<typeof vi.fn>;
	};
	let repository: AuditRepository;

	beforeEach(() => {
		mockPool = {
			query: vi.fn(),
		};
		mockLogger = {
			info: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
			error: vi.fn(),
		};
		repository = new AuditRepository(mockPool as any, mockLogger as any);
	});

	describe("eventExists", () => {
		it("should return true if event exists", async () => {
			mockPool.query.mockResolvedValue({ rows: [{ exists: true }] });

			const exists = await repository.eventExists("event-123");

			expect(exists).toBe(true);
			expect(mockPool.query).toHaveBeenCalledWith(
				expect.stringContaining("SELECT EXISTS"),
				["event-123"],
			);
		});

		it("should return false if event does not exist", async () => {
			mockPool.query.mockResolvedValue({ rows: [{ exists: false }] });

			const exists = await repository.eventExists("event-456");

			expect(exists).toBe(false);
		});
	});

	describe("insertEvent", () => {
		it("should insert event successfully", async () => {
			mockPool.query.mockResolvedValue({ rowCount: 1 });

			const payload: AuditEventPayload = {
				audit_id: "audit-123",
				event_type: "email.parsed",
				entity_type: "email",
				entity_id: "email-123",
				action: "process",
				outcome: "success",
				actor: { service: "mail-parser" },
				timestamp: "2024-01-15T10:00:00Z",
			};

			const inserted = await repository.insertEvent(payload);

			expect(inserted).toBe(true);
			expect(mockPool.query).toHaveBeenCalledWith(
				expect.stringContaining("INSERT INTO audit_event"),
				expect.any(Array),
			);
		});

		it("should handle duplicate key gracefully", async () => {
			mockPool.query.mockRejectedValue(
				new Error("duplicate key value violates unique constraint"),
			);

			const payload: AuditEventPayload = {
				audit_id: "audit-123",
				event_type: "email.parsed",
				entity_type: "email",
				action: "process",
				outcome: "success",
				actor: { service: "mail-parser" },
				timestamp: "2024-01-15T10:00:00Z",
			};

			const inserted = await repository.insertEvent(payload);

			expect(inserted).toBe(false);
			expect(mockLogger.debug).toHaveBeenCalledWith(
				"Duplicate audit event, skipping",
				expect.any(Object),
			);
		});

		it("should sanitize payload before insert", async () => {
			mockPool.query.mockResolvedValue({ rowCount: 1 });

			const payload: AuditEventPayload = {
				audit_id: "audit-123",
				event_type: "email.parsed",
				entity_type: "email",
				action: "process",
				outcome: "success",
				actor: { service: "mail-parser" },
				timestamp: "2024-01-15T10:00:00Z",
				details: {
					access_token: "should-be-redacted",
					email_id: "safe-value",
				},
			};

			await repository.insertEvent(payload);

			const insertCall = mockPool.query.mock.calls[0];
			const payloadJson = insertCall![1]![11] as Record<string, unknown>;
			const details = payloadJson["details"] as Record<string, unknown>;

			expect(details["access_token"]).toBe("[REDACTED]");
			expect(details["email_id"]).toBe("safe-value");
		});
	});
});
