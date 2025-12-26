import type { AuditEventPayload } from "@lattice/core-contracts";
import type {
	KafkaService,
	LoggerService,
	TelemetryService,
	WorkerConfig,
	WorkerContext,
} from "@lattice/worker-base";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditRepository } from "../db/audit.repository.js";
import { AuditWriterService } from "./worker.service.js";

const createMockKafkaService = (): KafkaService =>
	({
		subscribe: vi.fn(),
		produce: vi.fn(),
		produceToDeadLetter: vi.fn(),
		getTopics: vi.fn().mockReturnValue({
			topicIn: "lattice.audit.events.v1",
			topicOut: "",
			topicDLQ: "lattice.dlq.audit.events.v1",
		}),
	}) as unknown as KafkaService;

const createMockTelemetryService = (): TelemetryService =>
	({
		increment: vi.fn(),
		timing: vi.fn(),
		gauge: vi.fn(),
	}) as unknown as TelemetryService;

const createMockLogger = (): LoggerService =>
	({
		log: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}) as unknown as LoggerService;

const createMockConfig = (): WorkerConfig =>
	({
		service: "audit-writer",
		version: "0.1.0",
		env: "test",
		team: "platform",
		cloud: "local",
		region: "local",
		domain: "audit",
		stage: "audit",
		kafka: {
			brokers: ["localhost:9092"],
			clientId: "audit-writer",
			groupId: "audit-writer-group",
			ssl: false,
		},
		topics: {
			in: "lattice.audit.events.v1",
			out: "",
			dlq: "lattice.dlq.audit.events.v1",
		},
	}) as unknown as WorkerConfig;

const createTestPayload = (
	overrides: Partial<AuditEventPayload> = {},
): AuditEventPayload => ({
	audit_id: "audit-123",
	event_type: "email.parsed",
	entity_type: "email",
	entity_id: "email-456",
	action: "process",
	outcome: "success",
	actor: { service: "mail-parser", version: "0.1.0" },
	timestamp: new Date().toISOString(),
	...overrides,
});

const createTestContext = (): WorkerContext => ({
	traceId: "trace-123",
	spanId: "span-456",
	topic: "lattice.audit.events.v1",
	partition: 0,
	offset: "100",
});

describe("AuditWriterService", () => {
	let service: AuditWriterService;
	let mockKafka: KafkaService;
	let mockTelemetry: TelemetryService;
	let mockLogger: LoggerService;
	let mockConfig: WorkerConfig;
	let mockAuditRepo: AuditRepository;

	beforeEach(() => {
		mockKafka = createMockKafkaService();
		mockTelemetry = createMockTelemetryService();
		mockLogger = createMockLogger();
		mockConfig = createMockConfig();

		mockAuditRepo = {
			eventExists: vi.fn(),
			insertEvent: vi.fn(),
			insertEventWithContext: vi.fn(),
			getEventsByEntity: vi.fn(),
			getEventsByAccount: vi.fn(),
		} as unknown as AuditRepository;

		service = new AuditWriterService(
			mockKafka,
			mockTelemetry,
			mockLogger,
			mockConfig,
			mockAuditRepo,
		);
	});

	describe("Idempotency", () => {
		it("should skip processing when audit event already exists", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockAuditRepo.eventExists).mockResolvedValue(true);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("skip");
			expect(result.reason).toContain("already exists");
			expect(mockAuditRepo.insertEventWithContext).not.toHaveBeenCalled();
			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"audit.events.skipped",
				1,
				expect.objectContaining({ reason: "duplicate" }),
			);
		});

		it("should process successfully when event does not exist", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockAuditRepo.eventExists).mockResolvedValue(false);
			vi.mocked(mockAuditRepo.insertEventWithContext).mockResolvedValue(true);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(mockAuditRepo.insertEventWithContext).toHaveBeenCalledWith(
				payload,
				expect.any(Object),
			);
			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"audit.events.success",
				1,
				expect.objectContaining({ event_type: "email.parsed" }),
			);
		});

		it("should handle concurrent duplicate insert gracefully", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockAuditRepo.eventExists).mockResolvedValue(false);
			vi.mocked(mockAuditRepo.insertEventWithContext).mockResolvedValue(false);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("skip");
			expect(result.reason).toContain("Concurrent duplicate");
			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"audit.events.skipped",
				1,
				expect.objectContaining({ reason: "concurrent_duplicate" }),
			);
		});
	});

	describe("Validation", () => {
		it("should send to DLQ when event_type is missing", async () => {
			const payload = createTestPayload({ event_type: "" as any });
			const context = createTestContext();

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("event_type");
			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"audit.events.error",
				1,
				expect.objectContaining({ error_code: "missing_event_type" }),
			);
		});

		it("should send to DLQ when timestamp is missing", async () => {
			const payload = createTestPayload({ timestamp: "" });
			const context = createTestContext();

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("timestamp");
		});

		it("should send to DLQ when actor is missing", async () => {
			const payload = createTestPayload({ actor: undefined as any });
			const context = createTestContext();

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("actor");
		});
	});

	describe("Error Handling", () => {
		it("should retry on retryable database errors", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockAuditRepo.eventExists).mockResolvedValue(false);
			vi.mocked(mockAuditRepo.insertEventWithContext).mockRejectedValue(
				new Error("ECONNREFUSED: connection refused"),
			);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("retry");
			expect(result.reason).toContain("ECONNREFUSED");
		});

		it("should send to DLQ on non-retryable errors", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockAuditRepo.eventExists).mockResolvedValue(false);
			vi.mocked(mockAuditRepo.insertEventWithContext).mockRejectedValue(
				new Error("Invalid JSON format"),
			);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.error).toBeInstanceOf(Error);
		});
	});

	describe("Metrics", () => {
		it("should emit received metric on every event", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockAuditRepo.eventExists).mockResolvedValue(false);
			vi.mocked(mockAuditRepo.insertEventWithContext).mockResolvedValue(true);

			await (service as any).process(payload, context);

			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"audit.events.received",
				1,
				expect.objectContaining({ event_type: "email.parsed" }),
			);
		});

		it("should emit success metric on successful insert", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockAuditRepo.eventExists).mockResolvedValue(false);
			vi.mocked(mockAuditRepo.insertEventWithContext).mockResolvedValue(true);

			await (service as any).process(payload, context);

			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"audit.events.success",
				1,
				expect.objectContaining({ event_type: "email.parsed" }),
			);
		});
	});
});
