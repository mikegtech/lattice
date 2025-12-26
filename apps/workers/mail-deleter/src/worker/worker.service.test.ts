import type { MailDeleteRequestPayload } from "@lattice/core-contracts";
import type {
	KafkaService,
	LoggerService,
	TelemetryService,
	WorkerConfig,
	WorkerContext,
} from "@lattice/worker-base";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DeletionRepository,
	DeletionRequestRecord,
	EmailToDelete,
} from "../db/deletion.repository.js";
import type { MilvusService } from "../milvus/milvus.service.js";
import { MailDeleterService } from "./worker.service.js";

const createMockKafkaService = (): KafkaService =>
	({
		subscribe: vi.fn(),
		produce: vi.fn(),
		produceToDeadLetter: vi.fn(),
		getTopics: vi.fn().mockReturnValue({
			topicIn: "lattice.mail.delete.v1",
			topicOut: "lattice.mail.delete.completed.v1",
			topicDLQ: "lattice.dlq.mail.delete.v1",
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
		service: "mail-deleter",
		version: "0.1.0",
		env: "test",
		team: "platform",
		cloud: "local",
		region: "local",
		domain: "mail",
		stage: "delete",
		kafka: {
			brokers: ["localhost:9092"],
			clientId: "mail-deleter",
			groupId: "mail-deleter-group",
			ssl: false,
		},
		topics: {
			in: "lattice.mail.delete.v1",
			out: "lattice.mail.delete.completed.v1",
			dlq: "lattice.dlq.mail.delete.v1",
		},
	}) as unknown as WorkerConfig;

const createTestPayload = (
	overrides: Partial<MailDeleteRequestPayload> = {},
): MailDeleteRequestPayload => ({
	request_id: "delete-req-123",
	request_type: "single_email",
	tenant_id: "tenant-1",
	account_id: "account-1",
	email_id: "email-456",
	deletion_type: "soft",
	deletion_reason: "user_request",
	delete_vectors: true,
	delete_storage: false,
	delete_postgres: true,
	requested_at: new Date().toISOString(),
	...overrides,
});

const createTestContext = (): WorkerContext => ({
	traceId: "trace-123",
	spanId: "span-456",
	topic: "lattice.mail.delete.v1",
	partition: 0,
	offset: "100",
});

const createMockDeletionRecord = (
	status: "pending" | "in_progress" | "completed" | "failed" = "pending",
): DeletionRequestRecord => ({
	id: "delete-req-123",
	requested_at: new Date(),
	tenant_id: "tenant-1",
	account_id: "account-1",
	request_type: "single_email",
	request_json: {},
	status,
	emails_deleted: status === "completed" ? 1 : 0,
	chunks_deleted: status === "completed" ? 5 : 0,
	embeddings_deleted: status === "completed" ? 5 : 0,
	vectors_deleted: status === "completed" ? 5 : 0,
	storage_deleted: 0,
	started_at: status !== "pending" ? new Date() : null,
	completed_at: status === "completed" ? new Date() : null,
	last_error: status === "failed" ? "Previous error" : null,
});

const createMockEmailsToDelete = (count: number): EmailToDelete[] =>
	Array.from({ length: count }, (_, i) => ({
		id: `email-${i}`,
		provider_message_id: `msg-${i}`,
		tenant_id: "tenant-1",
		account_id: "account-1",
	}));

describe("MailDeleterService", () => {
	let service: MailDeleterService;
	let mockKafka: KafkaService;
	let mockTelemetry: TelemetryService;
	let mockLogger: LoggerService;
	let mockConfig: WorkerConfig;
	let mockDeletionRepo: DeletionRepository;
	let mockMilvusService: MilvusService;

	beforeEach(() => {
		mockKafka = createMockKafkaService();
		mockTelemetry = createMockTelemetryService();
		mockLogger = createMockLogger();
		mockConfig = createMockConfig();

		mockDeletionRepo = {
			getDeletionRequest: vi.fn(),
			upsertDeletionRequest: vi.fn(),
			markInProgress: vi.fn(),
			markCompleted: vi.fn(),
			markFailed: vi.fn(),
			getEmailsToDelete: vi.fn(),
			getChunksForEmails: vi.fn(),
			deleteEmbeddings: vi.fn(),
			deleteChunks: vi.fn(),
			deleteEmails: vi.fn(),
			softDeleteEmails: vi.fn(),
			deleteEmailData: vi.fn(),
		} as unknown as DeletionRepository;

		mockMilvusService = {
			deleteByPKs: vi.fn(),
			deleteByEmailIds: vi.fn(),
			deleteByAccount: vi.fn(),
			deleteByAlias: vi.fn(),
			healthCheck: vi.fn(),
			onModuleDestroy: vi.fn(),
		} as unknown as MilvusService;

		service = new MailDeleterService(
			mockKafka,
			mockTelemetry,
			mockLogger,
			mockConfig,
			mockDeletionRepo,
			mockMilvusService,
		);
	});

	describe("Idempotency", () => {
		it("should skip processing when deletion request is already completed", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: false,
				record: createMockDeletionRecord("completed"),
			});

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("skip");
			expect(result.reason).toContain("already completed");
			expect(mockDeletionRepo.markInProgress).not.toHaveBeenCalled();
			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"deletion.requests.skipped",
				1,
				expect.objectContaining({ reason: "already_completed" }),
			);
		});

		it("should retry processing when previous deletion failed", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const emails = createMockEmailsToDelete(1);

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: false,
				record: createMockDeletionRecord("failed"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue(emails);
			vi.mocked(mockMilvusService.deleteByEmailIds).mockResolvedValue({
				deleted: 1,
				errors: [],
			});
			vi.mocked(mockDeletionRepo.deleteEmailData).mockResolvedValue({
				emails_deleted: 1,
				chunks_deleted: 5,
				embeddings_deleted: 5,
			});

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(mockDeletionRepo.markInProgress).toHaveBeenCalled();
			expect(mockLogger.info).toHaveBeenCalledWith(
				"Retrying previously failed deletion",
				expect.any(Object),
			);
		});

		it("should process new deletion request successfully", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const emails = createMockEmailsToDelete(1);

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: true,
				record: createMockDeletionRecord("pending"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue(emails);
			vi.mocked(mockMilvusService.deleteByEmailIds).mockResolvedValue({
				deleted: 1,
				errors: [],
			});
			vi.mocked(mockDeletionRepo.deleteEmailData).mockResolvedValue({
				emails_deleted: 1,
				chunks_deleted: 5,
				embeddings_deleted: 5,
			});

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(result.output).toMatchObject({
				request_id: payload.request_id,
				emails_deleted: 1,
				chunks_deleted: 5,
				embeddings_deleted: 5,
				vectors_deleted: 1,
			});
			expect(mockDeletionRepo.markCompleted).toHaveBeenCalled();
		});
	});

	describe("Validation", () => {
		it("should send to DLQ when request_id is missing", async () => {
			const payload = createTestPayload({ request_id: "" });
			const context = createTestContext();

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("request_id");
		});

		it("should send to DLQ when request_type is missing", async () => {
			const payload = createTestPayload({ request_type: "" as any });
			const context = createTestContext();

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("request_type");
		});

		it("should send to DLQ when tenant_id is missing", async () => {
			const payload = createTestPayload({ tenant_id: "" });
			const context = createTestContext();

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("tenant_id");
		});

		it("should send to DLQ when email_id is missing for single_email request", async () => {
			const payload = createTestPayload({ email_id: undefined });
			const context = createTestContext();

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("email_id");
		});

		it("should send to DLQ when alias is missing for alias request", async () => {
			const payload = createTestPayload({
				request_type: "alias",
				alias: undefined,
			});
			const context = createTestContext();

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("alias");
		});

		it("should send to DLQ when cutoff_date is missing for retention_sweep", async () => {
			const payload = createTestPayload({
				request_type: "retention_sweep",
				cutoff_date: undefined,
			});
			const context = createTestContext();

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("cutoff_date");
		});
	});

	describe("Multi-scope Deletion", () => {
		it("should handle single_email deletion", async () => {
			const payload = createTestPayload({ request_type: "single_email" });
			const context = createTestContext();
			const emails = createMockEmailsToDelete(1);

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: true,
				record: createMockDeletionRecord("pending"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue(emails);
			vi.mocked(mockMilvusService.deleteByEmailIds).mockResolvedValue({
				deleted: 1,
				errors: [],
			});
			vi.mocked(mockDeletionRepo.deleteEmailData).mockResolvedValue({
				emails_deleted: 1,
				chunks_deleted: 5,
				embeddings_deleted: 5,
			});

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(mockMilvusService.deleteByEmailIds).toHaveBeenCalledWith([
				"email-0",
			]);
		});

		it("should handle account deletion with deleteByAccount", async () => {
			const payload = createTestPayload({
				request_type: "account",
				email_id: undefined,
			});
			const context = createTestContext();
			const emails = createMockEmailsToDelete(10);

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: true,
				record: createMockDeletionRecord("pending"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue(emails);
			vi.mocked(mockMilvusService.deleteByAccount).mockResolvedValue({
				deleted: 10,
				errors: [],
			});
			vi.mocked(mockDeletionRepo.deleteEmailData).mockResolvedValue({
				emails_deleted: 10,
				chunks_deleted: 50,
				embeddings_deleted: 50,
			});

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(mockMilvusService.deleteByAccount).toHaveBeenCalledWith(
				"tenant-1",
				"account-1",
			);
		});

		it("should handle alias deletion with deleteByAlias", async () => {
			const payload = createTestPayload({
				request_type: "alias",
				alias: "work@example.com",
				email_id: undefined,
			});
			const context = createTestContext();
			const emails = createMockEmailsToDelete(5);

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: true,
				record: createMockDeletionRecord("pending"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue(emails);
			vi.mocked(mockMilvusService.deleteByAlias).mockResolvedValue({
				deleted: 5,
				errors: [],
			});
			vi.mocked(mockDeletionRepo.deleteEmailData).mockResolvedValue({
				emails_deleted: 5,
				chunks_deleted: 25,
				embeddings_deleted: 25,
			});

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(mockMilvusService.deleteByAlias).toHaveBeenCalledWith(
				"tenant-1",
				"account-1",
				"work@example.com",
			);
		});

		it("should handle retention_sweep deletion", async () => {
			const cutoffDate = new Date(
				Date.now() - 90 * 24 * 60 * 60 * 1000,
			).toISOString();
			const payload = createTestPayload({
				request_type: "retention_sweep",
				cutoff_date: cutoffDate,
				retention_policy_id: "policy-1",
				email_id: undefined,
			});
			const context = createTestContext();
			const emails = createMockEmailsToDelete(100);

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: true,
				record: createMockDeletionRecord("pending"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue(emails);
			vi.mocked(mockMilvusService.deleteByEmailIds).mockResolvedValue({
				deleted: 100,
				errors: [],
			});
			vi.mocked(mockDeletionRepo.deleteEmailData).mockResolvedValue({
				emails_deleted: 100,
				chunks_deleted: 500,
				embeddings_deleted: 500,
			});

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(result.output.emails_deleted).toBe(100);
		});
	});

	describe("Partial Failure Handling", () => {
		it("should handle Milvus errors gracefully and continue with Postgres deletion", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const emails = createMockEmailsToDelete(1);

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: true,
				record: createMockDeletionRecord("pending"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue(emails);
			vi.mocked(mockMilvusService.deleteByEmailIds).mockRejectedValue(
				new Error("Milvus connection failed"),
			);
			vi.mocked(mockDeletionRepo.deleteEmailData).mockResolvedValue({
				emails_deleted: 1,
				chunks_deleted: 5,
				embeddings_deleted: 5,
			});

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(result.output.vectors_deleted).toBe(0);
			expect(result.output.emails_deleted).toBe(1);
			expect(mockLogger.error).toHaveBeenCalledWith(
				"Milvus deletion failed",
				expect.any(String),
				expect.any(String),
			);
		});

		it("should log warning for partial Milvus errors", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const emails = createMockEmailsToDelete(1);

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: true,
				record: createMockDeletionRecord("pending"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue(emails);
			vi.mocked(mockMilvusService.deleteByEmailIds).mockResolvedValue({
				deleted: 1,
				errors: ["Partial error: some vectors not found"],
			});
			vi.mocked(mockDeletionRepo.deleteEmailData).mockResolvedValue({
				emails_deleted: 1,
				chunks_deleted: 5,
				embeddings_deleted: 5,
			});

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(mockLogger.warn).toHaveBeenCalledWith(
				"Partial Milvus deletion errors",
				expect.objectContaining({
					errors: ["Partial error: some vectors not found"],
				}),
			);
		});

		it("should mark deletion as failed when Postgres deletion fails", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const emails = createMockEmailsToDelete(1);

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: true,
				record: createMockDeletionRecord("pending"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue(emails);
			vi.mocked(mockMilvusService.deleteByEmailIds).mockResolvedValue({
				deleted: 1,
				errors: [],
			});
			vi.mocked(mockDeletionRepo.deleteEmailData).mockRejectedValue(
				new Error("Foreign key constraint violation"),
			);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(mockDeletionRepo.markFailed).toHaveBeenCalledWith(
				payload.request_id,
				"Foreign key constraint violation",
			);
		});
	});

	describe("Empty Results", () => {
		it("should handle zero emails to delete gracefully", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: true,
				record: createMockDeletionRecord("pending"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue([]);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(result.output.emails_deleted).toBe(0);
			expect(result.output.vectors_deleted).toBe(0);
			expect(mockMilvusService.deleteByEmailIds).not.toHaveBeenCalled();
			expect(mockDeletionRepo.deleteEmailData).not.toHaveBeenCalled();
		});
	});

	describe("Feature Flags", () => {
		it("should skip Milvus deletion when delete_vectors is false", async () => {
			const payload = createTestPayload({ delete_vectors: false });
			const context = createTestContext();
			const emails = createMockEmailsToDelete(1);

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: true,
				record: createMockDeletionRecord("pending"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue(emails);
			vi.mocked(mockDeletionRepo.deleteEmailData).mockResolvedValue({
				emails_deleted: 1,
				chunks_deleted: 5,
				embeddings_deleted: 5,
			});

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(result.output.vectors_deleted).toBe(0);
			expect(mockMilvusService.deleteByEmailIds).not.toHaveBeenCalled();
		});

		it("should skip Postgres deletion when delete_postgres is false", async () => {
			const payload = createTestPayload({ delete_postgres: false });
			const context = createTestContext();
			const emails = createMockEmailsToDelete(1);

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: true,
				record: createMockDeletionRecord("pending"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue(emails);
			vi.mocked(mockMilvusService.deleteByEmailIds).mockResolvedValue({
				deleted: 1,
				errors: [],
			});

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(result.output.emails_deleted).toBe(0);
			expect(mockDeletionRepo.deleteEmailData).not.toHaveBeenCalled();
		});
	});

	describe("Metrics", () => {
		it("should emit received metric on every request", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: true,
				record: createMockDeletionRecord("pending"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue([]);

			await (service as any).process(payload, context);

			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"deletion.requests.received",
				1,
				expect.objectContaining({ request_type: "single_email" }),
			);
		});

		it("should emit success metric and gauges on completion", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const emails = createMockEmailsToDelete(1);

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: true,
				record: createMockDeletionRecord("pending"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue(emails);
			vi.mocked(mockMilvusService.deleteByEmailIds).mockResolvedValue({
				deleted: 1,
				errors: [],
			});
			vi.mocked(mockDeletionRepo.deleteEmailData).mockResolvedValue({
				emails_deleted: 1,
				chunks_deleted: 5,
				embeddings_deleted: 5,
			});

			await (service as any).process(payload, context);

			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"deletion.requests.success",
				1,
				expect.objectContaining({ request_type: "single_email" }),
			);
			expect(mockTelemetry.gauge).toHaveBeenCalledWith(
				"deletion.emails_deleted",
				1,
			);
			expect(mockTelemetry.gauge).toHaveBeenCalledWith(
				"deletion.vectors_deleted",
				1,
			);
		});

		it("should emit timing metric for Milvus operations", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const emails = createMockEmailsToDelete(1);

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: true,
				record: createMockDeletionRecord("pending"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue(emails);
			vi.mocked(mockMilvusService.deleteByEmailIds).mockResolvedValue({
				deleted: 1,
				errors: [],
			});
			vi.mocked(mockDeletionRepo.deleteEmailData).mockResolvedValue({
				emails_deleted: 1,
				chunks_deleted: 5,
				embeddings_deleted: 5,
			});

			await (service as any).process(payload, context);

			expect(mockTelemetry.timing).toHaveBeenCalledWith(
				"deletion.milvus_ms",
				expect.any(Number),
				expect.objectContaining({ request_type: "single_email" }),
			);
		});
	});

	describe("Error Handling", () => {
		it("should retry on retryable database errors", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockRejectedValue(
				new Error("ECONNREFUSED: connection refused"),
			);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("retry");
			expect(result.reason).toContain("ECONNREFUSED");
		});

		it("should send to DLQ on non-retryable errors", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockRejectedValue(
				new Error("Invalid UUID format"),
			);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.error).toBeInstanceOf(Error);
		});

		it("should handle markFailed errors gracefully", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const emails = createMockEmailsToDelete(1);

			vi.mocked(mockDeletionRepo.upsertDeletionRequest).mockResolvedValue({
				isNew: true,
				record: createMockDeletionRecord("pending"),
			});
			vi.mocked(mockDeletionRepo.getEmailsToDelete).mockResolvedValue(emails);
			vi.mocked(mockMilvusService.deleteByEmailIds).mockResolvedValue({
				deleted: 1,
				errors: [],
			});
			vi.mocked(mockDeletionRepo.deleteEmailData).mockRejectedValue(
				new Error("Original error"),
			);
			vi.mocked(mockDeletionRepo.markFailed).mockRejectedValue(
				new Error("Failed to mark as failed"),
			);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(mockLogger.error).toHaveBeenCalledWith(
				"Failed to mark deletion as failed",
				expect.any(String),
				expect.any(String),
			);
		});
	});
});
