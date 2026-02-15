import type { MailEmbedPayload } from "@lattice/core-contracts";
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
import type { ElasticsearchConfig } from "../elasticsearch/elasticsearch.config.js";
import {
	ElasticsearchService,
	type IndexResult,
} from "../elasticsearch/elasticsearch.service.js";
import { EsUpserterService } from "./worker.service.js";

// Mock implementations
const createMockKafkaService = (): KafkaService =>
	({
		subscribe: vi.fn(),
		produce: vi.fn(),
		produceToDeadLetter: vi.fn(),
		getTopics: vi.fn().mockReturnValue({
			topicIn: "lattice.mail.embed.v1",
			topicOut: "lattice.es.upsert.v1",
			topicDLQ: "lattice.dlq.es.upsert.v1",
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
		service: "es-upserter",
		version: "0.1.0",
		env: "test",
		team: "platform",
		cloud: "local",
		region: "local",
		domain: "mail",
		stage: "es-upsert",
		kafka: {
			brokers: ["localhost:9092"],
			clientId: "es-upserter",
			groupId: "es-upserter-group",
			ssl: false,
		},
		topics: {
			in: "lattice.mail.embed.v1",
			out: "lattice.es.upsert.v1",
			dlq: "lattice.dlq.es.upsert.v1",
		},
	}) as unknown as WorkerConfig;

const createEsConfig = (
	overrides: Partial<ElasticsearchConfig> = {},
): ElasticsearchConfig => ({
	node: "http://localhost:9200",
	index: "email_chunks_v1",
	requestTimeoutMs: 30000,
	aliasPattern: "realty-*@woodcreek.me",
	...overrides,
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

describe("EsUpserterService", () => {
	let service: EsUpserterService;
	let mockKafka: KafkaService;
	let mockTelemetry: TelemetryService;
	let mockLogger: LoggerService;
	let mockConfig: WorkerConfig;
	let mockEsConfig: ElasticsearchConfig;
	let mockUpsertRepo: UpsertRepository;
	let mockEsService: ElasticsearchService;

	beforeEach(() => {
		mockKafka = createMockKafkaService();
		mockTelemetry = createMockTelemetryService();
		mockLogger = createMockLogger();
		mockConfig = createMockConfig();
		mockEsConfig = createEsConfig();

		mockUpsertRepo = {
			getEmbeddingWithMetadata: vi.fn(),
			getEmailMetadata: vi.fn(),
		} as unknown as UpsertRepository;

		mockEsService = {
			documentExists: vi.fn(),
			indexDocument: vi.fn(),
			ensureIndex: vi.fn(),
			healthCheck: vi.fn(),
			getIndexName: vi.fn().mockReturnValue("email_chunks_v1"),
		} as unknown as ElasticsearchService;

		service = new EsUpserterService(
			mockKafka,
			mockTelemetry,
			mockLogger,
			mockConfig,
			mockUpsertRepo,
			mockEsService,
			mockEsConfig,
		);
	});

	describe("Alias Filter", () => {
		it("should skip when alias does not match pattern", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue({
				tenant_id: "tenant-1",
				account_id: "account-1",
				alias: "other-user@gmail.com",
				received_at: new Date(),
			} as EmailMetadata);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("skip");
			expect(result.reason).toContain("does not match pattern");
			expect(mockEsService.documentExists).not.toHaveBeenCalled();
			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"messages.skipped",
				1,
				expect.objectContaining({ reason: "alias_filtered" }),
			);
		});

		it("should process all emails when no alias pattern configured", async () => {
			// Reconfigure without alias pattern
			mockEsConfig = createEsConfig({ aliasPattern: undefined });
			service = new EsUpserterService(
				mockKafka,
				mockTelemetry,
				mockLogger,
				mockConfig,
				mockUpsertRepo,
				mockEsService,
				mockEsConfig,
			);

			const payload = createTestPayload();
			const context = createTestContext();
			const vector = new Array(384).fill(0.1);

			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue({
				tenant_id: "tenant-1",
				account_id: "account-1",
				alias: "any-alias@anywhere.com",
				received_at: new Date(),
			} as EmailMetadata);
			vi.mocked(mockEsService.documentExists).mockResolvedValue(false);
			vi.mocked(mockUpsertRepo.getEmbeddingWithMetadata).mockResolvedValue({
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_version: payload.embedding_version,
				embedding_model: payload.embedding_model,
				vector_data: vectorToBuffer(vector),
				section_type: "body",
				chunk_text: "Some email content",
			} as EmbeddingWithMetadata);
			vi.mocked(mockEsService.indexDocument).mockResolvedValue({
				success: true,
				isUpdate: false,
			} as IndexResult);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
		});

		it("should process when alias matches pattern", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const vector = new Array(384).fill(0.1);

			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue({
				tenant_id: "tenant-1",
				account_id: "account-1",
				alias: "realty-abc@woodcreek.me",
				received_at: new Date(),
			} as EmailMetadata);
			vi.mocked(mockEsService.documentExists).mockResolvedValue(false);
			vi.mocked(mockUpsertRepo.getEmbeddingWithMetadata).mockResolvedValue({
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_version: payload.embedding_version,
				embedding_model: payload.embedding_model,
				vector_data: vectorToBuffer(vector),
				section_type: "body",
				chunk_text: "Some email content",
			} as EmbeddingWithMetadata);
			vi.mocked(mockEsService.indexDocument).mockResolvedValue({
				success: true,
				isUpdate: false,
			} as IndexResult);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
		});
	});

	describe("Idempotency", () => {
		it("should skip when document already exists in Elasticsearch", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue({
				tenant_id: "tenant-1",
				account_id: "account-1",
				alias: "realty-abc@woodcreek.me",
				received_at: new Date(),
			} as EmailMetadata);
			vi.mocked(mockEsService.documentExists).mockResolvedValue(true);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("skip");
			expect(result.reason).toContain("already exists");
			expect(mockUpsertRepo.getEmbeddingWithMetadata).not.toHaveBeenCalled();
			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"messages.skipped",
				1,
				expect.objectContaining({ reason: "duplicate" }),
			);
		});
	});

	describe("Missing Data (DLQ)", () => {
		it("should send to DLQ when embedding not found", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue({
				tenant_id: "tenant-1",
				account_id: "account-1",
				alias: "realty-abc@woodcreek.me",
				received_at: new Date(),
			} as EmailMetadata);
			vi.mocked(mockEsService.documentExists).mockResolvedValue(false);
			vi.mocked(mockUpsertRepo.getEmbeddingWithMetadata).mockResolvedValue(
				null,
			);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("Embedding not found");
			expect(result.error).toBeInstanceOf(Error);
			expect(mockEsService.indexDocument).not.toHaveBeenCalled();
			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"messages.error",
				1,
				expect.objectContaining({ error_code: "not_found" }),
			);
		});

		it("should send to DLQ when email metadata not found", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue(null);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("Email metadata not found");
			expect(result.error).toBeInstanceOf(Error);
			expect(mockEsService.documentExists).not.toHaveBeenCalled();
			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"messages.error",
				1,
				expect.objectContaining({ error_code: "metadata_not_found" }),
			);
		});
	});

	describe("Success Path", () => {
		it("should index document and return success payload", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const vector = new Array(384).fill(0.1);

			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue({
				tenant_id: "tenant-1",
				account_id: "account-1",
				alias: "realty-abc@woodcreek.me",
				received_at: new Date(),
			} as EmailMetadata);
			vi.mocked(mockEsService.documentExists).mockResolvedValue(false);
			vi.mocked(mockUpsertRepo.getEmbeddingWithMetadata).mockResolvedValue({
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_version: payload.embedding_version,
				embedding_model: payload.embedding_model,
				vector_data: vectorToBuffer(vector),
				section_type: "body",
				chunk_text: "Hello world email content",
			} as EmbeddingWithMetadata);
			vi.mocked(mockEsService.indexDocument).mockResolvedValue({
				success: true,
				isUpdate: false,
			} as IndexResult);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(result.output).toMatchObject({
				email_id: payload.email_id,
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_version: payload.embedding_version,
				es_index: "email_chunks_v1",
				is_update: false,
			});
			expect(result.output.es_doc_id).toBeDefined();
			expect(result.output.upserted_at).toBeDefined();
			expect(mockTelemetry.increment).toHaveBeenCalledWith(
				"messages.success",
				1,
				expect.objectContaining({ stage: "es-upsert" }),
			);
			expect(mockTelemetry.timing).toHaveBeenCalledWith(
				"elasticsearch.index.duration_ms",
				expect.any(Number),
				expect.objectContaining({ stage: "es-upsert" }),
			);
		});
	});

	describe("Error Handling", () => {
		it("should retry on retryable Elasticsearch error (timeout)", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const vector = new Array(384).fill(0.1);

			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue({
				tenant_id: "tenant-1",
				account_id: "account-1",
				alias: "realty-abc@woodcreek.me",
				received_at: new Date(),
			} as EmailMetadata);
			vi.mocked(mockEsService.documentExists).mockResolvedValue(false);
			vi.mocked(mockUpsertRepo.getEmbeddingWithMetadata).mockResolvedValue({
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_version: payload.embedding_version,
				embedding_model: payload.embedding_model,
				vector_data: vectorToBuffer(vector),
				section_type: "body",
				chunk_text: "content",
			} as EmbeddingWithMetadata);
			vi.mocked(mockEsService.indexDocument).mockResolvedValue({
				success: false,
				isUpdate: false,
				error: "ConnectionError: ETIMEDOUT",
			});

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("retry");
			expect(result.reason).toContain("ETIMEDOUT");
		});

		it("should send to DLQ on non-retryable Elasticsearch error", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const vector = new Array(384).fill(0.1);

			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue({
				tenant_id: "tenant-1",
				account_id: "account-1",
				alias: "realty-abc@woodcreek.me",
				received_at: new Date(),
			} as EmailMetadata);
			vi.mocked(mockEsService.documentExists).mockResolvedValue(false);
			vi.mocked(mockUpsertRepo.getEmbeddingWithMetadata).mockResolvedValue({
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_version: payload.embedding_version,
				embedding_model: payload.embedding_model,
				vector_data: vectorToBuffer(vector),
				section_type: "body",
				chunk_text: "content",
			} as EmbeddingWithMetadata);
			vi.mocked(mockEsService.indexDocument).mockResolvedValue({
				success: false,
				isUpdate: false,
				error: "mapper_parsing_exception: invalid field mapping",
			});

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("mapper_parsing_exception");
		});

		it("should retry on thrown connection error", async () => {
			const payload = createTestPayload();
			const context = createTestContext();

			vi.mocked(mockUpsertRepo.getEmailMetadata).mockRejectedValue(
				new Error("ECONNREFUSED"),
			);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("retry");
			expect(result.reason).toContain("ECONNREFUSED");
		});
	});

	describe("Update Detection", () => {
		it("should mark as update when replacing existing document", async () => {
			const payload = createTestPayload();
			const context = createTestContext();
			const vector = new Array(384).fill(0.1);

			vi.mocked(mockUpsertRepo.getEmailMetadata).mockResolvedValue({
				tenant_id: "tenant-1",
				account_id: "account-1",
				alias: "realty-abc@woodcreek.me",
				received_at: new Date(),
			} as EmailMetadata);
			vi.mocked(mockEsService.documentExists).mockResolvedValue(false);
			vi.mocked(mockUpsertRepo.getEmbeddingWithMetadata).mockResolvedValue({
				chunk_id: payload.chunk_id,
				chunk_hash: payload.chunk_hash,
				embedding_version: payload.embedding_version,
				embedding_model: payload.embedding_model,
				vector_data: vectorToBuffer(vector),
				section_type: "body",
				chunk_text: "content",
			} as EmbeddingWithMetadata);
			vi.mocked(mockEsService.indexDocument).mockResolvedValue({
				success: true,
				isUpdate: true,
			} as IndexResult);

			const result = await (service as any).process(payload, context);

			expect(result.status).toBe("success");
			expect(result.output.is_update).toBe(true);
		});
	});
});

describe("ElasticsearchService.generateDocId", () => {
	it("should produce consistent hashes (20-char hex)", () => {
		const id = ElasticsearchService.generateDocId(
			"email-1",
			"chunk-hash-1",
			"v1",
		);

		expect(id).toMatch(/^[a-f0-9]{20}$/);

		const id2 = ElasticsearchService.generateDocId(
			"email-1",
			"chunk-hash-1",
			"v1",
		);
		expect(id).toBe(id2);
	});

	it("should produce different hashes for different inputs", () => {
		const id1 = ElasticsearchService.generateDocId(
			"email-1",
			"chunk-hash-1",
			"v1",
		);
		const id2 = ElasticsearchService.generateDocId(
			"email-2",
			"chunk-hash-1",
			"v1",
		);
		const id3 = ElasticsearchService.generateDocId(
			"email-1",
			"chunk-hash-2",
			"v1",
		);
		const id4 = ElasticsearchService.generateDocId(
			"email-1",
			"chunk-hash-1",
			"v2",
		);

		expect(new Set([id1, id2, id3, id4]).size).toBe(4);
	});
});

describe("UpsertRepository.bufferToVector", () => {
	it("should correctly convert Buffer to float32 array", async () => {
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
