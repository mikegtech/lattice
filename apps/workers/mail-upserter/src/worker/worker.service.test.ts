import type {
	MailEmbedPayload,
	MailUpsertPayload,
} from "@lattice/core-contracts";
import type {
	KafkaService,
	LoggerService,
	TelemetryService,
	WorkerConfig,
	WorkerContext,
} from "@lattice/worker-base";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	EmailMetadata,
	EmbeddingWithMetadata,
	UpsertRepository,
} from "../db/upsert.repository.js";
import type { MilvusConfig } from "../milvus/milvus.config.js";
import { MilvusService, type VectorRecord } from "../milvus/milvus.service.js";
import { MailUpserterService } from "./worker.service.js";

// Mock implementations
const createMockKafkaService = (): KafkaService =>
	({
		subscribe: vi.fn(),
		produce: vi.fn(),
		produceToDeadLetter: vi.fn(),
		getTopics: vi.fn().mockReturnValue({
			topicIn: "lattice.mail.embed.v1",
			topicOut: "lattice.mail.upsert.v1",
			topicDLQ: "lattice.dlq.mail.upsert.v1",
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
		service: "mail-upserter",
		version: "0.1.0",
		env: "test",
		team: "platform",
		cloud: "local",
		region: "local",
		domain: "mail",
		stage: "upsert",
		kafka: {
			brokers: ["localhost:9092"],
			clientId: "mail-upserter",
			groupId: "mail-upserter-group",
			ssl: false,
		},
		topics: {
			in: "lattice.mail.embed.v1",
			out: "lattice.mail.upsert.v1",
			dlq: "lattice.dlq.mail.upsert.v1",
		},
	}) as unknown as WorkerConfig;

const createMilvusConfig = (dimension = 384): MilvusConfig => ({
	host: "localhost",
	port: 19530,
	address: "localhost:19530",
	collection: "email_chunks_v1",
	dimension,
	indexType: "HNSW" as const,
	hnswM: 16,
	hnswEfConstruction: 256,
	metricType: "COSINE" as const,
	batchSize: 100,
	connectTimeoutMs: 10000,
});

const createTestPayload = (
	overrides: Partial<MailEmbedPayload> = {},
): MailEmbedPayload => ({
	provider_message_id: "provider-123",
	email_id: "email-uuid-123",
	chunk_id: "chunk-uuid-456",
	chunk_hash: "abc123def456", // pragma: allowlist secret
	embedding_id: "embed-uuid-789",
	embedding_model: "all-MiniLM-L6-v2",
	embedding_version: "v1",
	embedding_dimensions: 384,
	vector_storage: "postgres",
	embedded_at: new Date().toISOString(),
	...overrides,
});

const createTestContext = (): WorkerContext => ({
	traceId: "trace-123",
	spanId: "span-456",
	topic: "lattice.mail.embed.v1",
	partition: 0,
	offset: "100",
});

// Helper to create a float32 buffer from array
const vectorToBuffer = (vector: number[]): Buffer => {
	const buffer = Buffer.alloc(vector.length * 4);
	vector.forEach((val, i) => buffer.writeFloatLE(val, i * 4));
	return buffer;
};

describe("MailUpserterService", () => {
	let service: MailUpserterService;
	let mockKafka: KafkaService;
	let mockTelemetry: TelemetryService;
	let mockLogger: LoggerService;
	let mockConfig: WorkerConfig;
	let mockMilvusConfig: MilvusConfig;
	let mockUpsertRepo: UpsertRepository;
	let mockMilvusService: MilvusService;

	beforeEach(() => {
		mockKafka = createMockKafkaService();
		mockTelemetry = createMockTelemetryService();
		mockLogger = createMockLogger();
		mockConfig = createMockConfig();
		mockMilvusConfig = createMilvusConfig(384);

		mockUpsertRepo = {
			vectorExists: vi.fn(),
			getEmbeddingWithMetadata: vi.fn(),
			getEmailMetadata: vi.fn(),
			updateVectorId: vi.fn(),
			updateVectorIds: vi.fn(),
		} as unknown as UpsertRepository;

		mockMilvusService = {
			upsert: vi.fn(),
			ensureCollection: vi.fn(),
			getExistingPKs: vi.fn(),
			healthCheck: vi.fn(),
		} as unknown as MilvusService;

		service = new MailUpserterService(
			mockKafka,
			mockTelemetry,
			mockLogger,
			mockConfig,
			mockUpsertRepo,
			mockMilvusService,
			mockMilvusConfig,
		);
	});

	describe("Idempotency", () => {
		it("should skip processing when vector already exists in Postgres", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			// Vector already exists (idempotency check via Postgres)
			vi.mocked(mockUpsertRepo.vectorExists).mockResolvedValue(true);

			// Access the protected process method
			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("skip");
			expect(result.reason).toContain("already exists");
			expect(mockMilvusService.upsert).not.toHaveBeenCalled();
			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"messages.skipped",
				1,
				expect.objectContaining({ reason: "duplicate" }),
			);
		});

		it("should generate deterministic PK for same email_id + chunk_hash + embedding_version", () => {
			const pk1 = MilvusService.generatePK("email-1", "hash-1", "v1");
			const pk2 = MilvusService.generatePK("email-1", "hash-1", "v1");
			const pk3 = MilvusService.generatePK("email-1", "hash-1", "v2");

			expect(pk1).toBe(pk2);
			expect(pk1).not.toBe(pk3);
			expect(pk1).toHaveLength(64); // SHA256 hex
		});

		it("should process successfully when vector does not exist", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const vector = new Array(384).fill(0.1);

			vi.mocked(mockUpsertRepo.vectorExists).mockResolvedValue(false);
			vi.mocked(mockUpsertRepo.getEmbeddingWithMetadata).mockResolvedValue({
				embedding_id: payload.embedding_id,
				email_id: payload.email_id,
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_model: payload.embedding_model,
				embedding_version: payload.embedding_version,
				vector_dim: 384,
				vector_data: vectorToBuffer(vector),
				embedded_at: new Date(),
				tenant_id: "tenant-1",
				account_id: "account-1",
				section_type: "body",
				received_at: new Date(),
			} as EmbeddingWithMetadata);
			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue({
				tenant_id: "tenant-1",
				account_id: "account-1",
				alias: "user@example.com",
				received_at: new Date(),
			} as EmailMetadata);
			vi.mocked(mockMilvusService.upsert).mockResolvedValue([
				{ pk: "test-pk", success: true, isUpdate: false },
			]);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(result.output).toMatchObject({
				email_id: payload.email_id,
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_version: payload.embedding_version,
				is_update: false,
			});
			expect(mockUpsertRepo.updateVectorId).toHaveBeenCalled();
		});
	});

	describe("Dimension Mismatch", () => {
		it("should send to DLQ when vector dimension does not match config", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const wrongDimensionVector = new Array(512).fill(0.1); // Wrong dimension

			vi.mocked(mockUpsertRepo.vectorExists).mockResolvedValue(false);
			vi.mocked(mockUpsertRepo.getEmbeddingWithMetadata).mockResolvedValue({
				embedding_id: payload.embedding_id,
				email_id: payload.email_id,
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_model: payload.embedding_model,
				embedding_version: payload.embedding_version,
				vector_dim: 512,
				vector_data: vectorToBuffer(wrongDimensionVector),
				embedded_at: new Date(),
				tenant_id: "tenant-1",
				account_id: "account-1",
				section_type: "body",
				received_at: new Date(),
			} as EmbeddingWithMetadata);
			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue({
				tenant_id: "tenant-1",
				account_id: "account-1",
				alias: null,
				received_at: new Date(),
			} as EmailMetadata);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("Dimension mismatch");
			expect(result.reason).toContain("expected 384");
			expect(result.reason).toContain("got 512");
			expect(result.error).toBeInstanceOf(Error);
			expect(mockMilvusService.upsert).not.toHaveBeenCalled();
			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"messages.error",
				1,
				expect.objectContaining({ error_code: "dimension_mismatch" }),
			);
		});
	});

	describe("Missing Vector Reference (Embedding Not Found)", () => {
		it("should send to DLQ when embedding is not found in database", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockUpsertRepo.vectorExists).mockResolvedValue(false);
			vi.mocked(mockUpsertRepo.getEmbeddingWithMetadata).mockResolvedValue(
				null,
			);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("Embedding not found");
			expect(result.error).toBeInstanceOf(Error);
			expect(mockMilvusService.upsert).not.toHaveBeenCalled();
			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"messages.error",
				1,
				expect.objectContaining({ error_code: "not_found" }),
			);
		});

		it("should send to DLQ when email metadata is not found", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const vector = new Array(384).fill(0.1);

			vi.mocked(mockUpsertRepo.vectorExists).mockResolvedValue(false);
			vi.mocked(mockUpsertRepo.getEmbeddingWithMetadata).mockResolvedValue({
				embedding_id: payload.embedding_id,
				email_id: payload.email_id,
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_model: payload.embedding_model,
				embedding_version: payload.embedding_version,
				vector_dim: 384,
				vector_data: vectorToBuffer(vector),
				embedded_at: new Date(),
				tenant_id: "tenant-1",
				account_id: "account-1",
				section_type: "body",
				received_at: new Date(),
			} as EmbeddingWithMetadata);
			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue(null);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("Email metadata not found");
			expect(result.error).toBeInstanceOf(Error);
			expect(mockMilvusService.upsert).not.toHaveBeenCalled();
			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"messages.error",
				1,
				expect.objectContaining({ error_code: "metadata_not_found" }),
			);
		});
	});

	describe("Milvus Errors", () => {
		it("should send to DLQ on non-retryable Milvus error", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const vector = new Array(384).fill(0.1);

			vi.mocked(mockUpsertRepo.vectorExists).mockResolvedValue(false);
			vi.mocked(mockUpsertRepo.getEmbeddingWithMetadata).mockResolvedValue({
				embedding_id: payload.embedding_id,
				email_id: payload.email_id,
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_model: payload.embedding_model,
				embedding_version: payload.embedding_version,
				vector_dim: 384,
				vector_data: vectorToBuffer(vector),
				embedded_at: new Date(),
				tenant_id: "tenant-1",
				account_id: "account-1",
				section_type: "body",
				received_at: new Date(),
			} as EmbeddingWithMetadata);
			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue({
				tenant_id: "tenant-1",
				account_id: "account-1",
				alias: null,
				received_at: new Date(),
			} as EmailMetadata);
			vi.mocked(mockMilvusService.upsert).mockResolvedValue([
				{
					pk: "test-pk",
					success: false,
					isUpdate: false,
					error: "Invalid schema",
				},
			]);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("Invalid schema");
		});

		it("should retry on transient Milvus error (timeout)", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const vector = new Array(384).fill(0.1);

			vi.mocked(mockUpsertRepo.vectorExists).mockResolvedValue(false);
			vi.mocked(mockUpsertRepo.getEmbeddingWithMetadata).mockResolvedValue({
				embedding_id: payload.embedding_id,
				email_id: payload.email_id,
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_model: payload.embedding_model,
				embedding_version: payload.embedding_version,
				vector_dim: 384,
				vector_data: vectorToBuffer(vector),
				embedded_at: new Date(),
				tenant_id: "tenant-1",
				account_id: "account-1",
				section_type: "body",
				received_at: new Date(),
			} as EmbeddingWithMetadata);
			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue({
				tenant_id: "tenant-1",
				account_id: "account-1",
				alias: null,
				received_at: new Date(),
			} as EmailMetadata);
			vi.mocked(mockMilvusService.upsert).mockResolvedValue([
				{
					pk: "test-pk",
					success: false,
					isUpdate: false,
					error: "Connection timeout",
				},
			]);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("retry");
			expect(result.reason).toContain("timeout");
		});

		it("should retry on connection refused error", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const vector = new Array(384).fill(0.1);

			vi.mocked(mockUpsertRepo.vectorExists).mockResolvedValue(false);
			vi.mocked(mockUpsertRepo.getEmbeddingWithMetadata).mockResolvedValue({
				embedding_id: payload.embedding_id,
				email_id: payload.email_id,
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_model: payload.embedding_model,
				embedding_version: payload.embedding_version,
				vector_dim: 384,
				vector_data: vectorToBuffer(vector),
				embedded_at: new Date(),
				tenant_id: "tenant-1",
				account_id: "account-1",
				section_type: "body",
				received_at: new Date(),
			} as EmbeddingWithMetadata);
			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue({
				tenant_id: "tenant-1",
				account_id: "account-1",
				alias: null,
				received_at: new Date(),
			} as EmailMetadata);
			vi.mocked(mockMilvusService.upsert).mockResolvedValue([
				{
					pk: "test-pk",
					success: false,
					isUpdate: false,
					error: "ECONNREFUSED",
				},
			]);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("retry");
			expect(result.reason).toContain("ECONNREFUSED");
		});
	});

	describe("Update Detection", () => {
		it("should mark as update when replacing existing vector", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const vector = new Array(384).fill(0.1);

			vi.mocked(mockUpsertRepo.vectorExists).mockResolvedValue(false);
			vi.mocked(mockUpsertRepo.getEmbeddingWithMetadata).mockResolvedValue({
				embedding_id: payload.embedding_id,
				email_id: payload.email_id,
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_model: payload.embedding_model,
				embedding_version: payload.embedding_version,
				vector_dim: 384,
				vector_data: vectorToBuffer(vector),
				embedded_at: new Date(),
				tenant_id: "tenant-1",
				account_id: "account-1",
				section_type: "body",
				received_at: new Date(),
			} as EmbeddingWithMetadata);
			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue({
				tenant_id: "tenant-1",
				account_id: "account-1",
				alias: "user@example.com",
				received_at: new Date(),
			} as EmailMetadata);
			vi.mocked(mockMilvusService.upsert).mockResolvedValue([
				{ pk: "test-pk", success: true, isUpdate: true },
			]);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(result.output.is_update).toBe(true);
		});
	});
});

describe("MilvusService.generatePK", () => {
	it("should produce consistent SHA256 hashes", () => {
		const pk = MilvusService.generatePK("email-1", "chunk-hash-1", "v1");

		// Should be 64 character hex string (SHA256)
		expect(pk).toMatch(/^[a-f0-9]{64}$/);

		// Same inputs = same output
		const pk2 = MilvusService.generatePK("email-1", "chunk-hash-1", "v1");
		expect(pk).toBe(pk2);
	});

	it("should produce different hashes for different inputs", () => {
		const pk1 = MilvusService.generatePK("email-1", "chunk-hash-1", "v1");
		const pk2 = MilvusService.generatePK("email-2", "chunk-hash-1", "v1");
		const pk3 = MilvusService.generatePK("email-1", "chunk-hash-2", "v1");
		const pk4 = MilvusService.generatePK("email-1", "chunk-hash-1", "v2");

		expect(new Set([pk1, pk2, pk3, pk4]).size).toBe(4);
	});
});

describe("UpsertRepository.bufferToVector", () => {
	it("should correctly convert Buffer to float32 array", async () => {
		// Dynamically import the actual function
		const { UpsertRepository } = await import("../db/upsert.repository.js");

		const testVector = [0.1, 0.2, 0.3, -0.5, 1.0];
		const buffer = Buffer.alloc(testVector.length * 4);
		testVector.forEach((val, i) => buffer.writeFloatLE(val, i * 4));

		const result = UpsertRepository.bufferToVector(buffer);

		expect(result.length).toBe(testVector.length);
		result.forEach((val, i) => {
			expect(val).toBeCloseTo(testVector[i]!, 5);
		});
	});
});
