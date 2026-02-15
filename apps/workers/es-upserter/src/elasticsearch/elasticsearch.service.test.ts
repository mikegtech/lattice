import type { LoggerService } from "@lattice/worker-base";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElasticsearchConfig } from "./elasticsearch.config.js";
import { ElasticsearchService } from "./elasticsearch.service.js";

// Mock the Elasticsearch client
const mockExists = vi.fn();
const mockIndex = vi.fn();
const mockIndicesExists = vi.fn();
const mockIndicesCreate = vi.fn();
const mockClusterHealth = vi.fn();
const mockClose = vi.fn();

vi.mock("@elastic/elasticsearch", () => ({
	Client: vi.fn().mockImplementation(() => ({
		exists: mockExists,
		index: mockIndex,
		indices: {
			exists: mockIndicesExists,
			create: mockIndicesCreate,
		},
		cluster: {
			health: mockClusterHealth,
		},
		close: mockClose,
	})),
}));

const createMockLogger = (): LoggerService =>
	({
		log: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}) as unknown as LoggerService;

const createEsConfig = (): ElasticsearchConfig => ({
	node: "http://localhost:9200",
	index: "email_chunks_v1",
	requestTimeoutMs: 30000,
});

describe("ElasticsearchService", () => {
	let service: ElasticsearchService;
	let mockLogger: LoggerService;
	let mockConfig: ElasticsearchConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		mockLogger = createMockLogger();
		mockConfig = createEsConfig();

		service = new ElasticsearchService(mockConfig, mockLogger);
	});

	describe("generateDocId", () => {
		it("should generate deterministic doc IDs", () => {
			const id1 = ElasticsearchService.generateDocId("email-1", "hash-1", "v1");
			const id2 = ElasticsearchService.generateDocId("email-1", "hash-1", "v1");

			expect(id1).toBe(id2);
		});

		it("should generate different IDs for different inputs", () => {
			const ids = [
				ElasticsearchService.generateDocId("email-1", "hash-1", "v1"),
				ElasticsearchService.generateDocId("email-2", "hash-1", "v1"),
				ElasticsearchService.generateDocId("email-1", "hash-2", "v1"),
			];

			const uniqueIds = new Set(ids);
			expect(uniqueIds.size).toBe(3);
		});

		it("should generate different IDs for different embedding versions", () => {
			const id1 = ElasticsearchService.generateDocId("email-1", "hash-1", "v1");
			const id2 = ElasticsearchService.generateDocId("email-1", "hash-1", "v2");

			expect(id1).not.toBe(id2);
		});

		it("should produce a 20-character hex string", () => {
			const id = ElasticsearchService.generateDocId("email-1", "hash-1", "v1");

			expect(id).toHaveLength(20);
			expect(id).toMatch(/^[a-f0-9]{20}$/);
		});
	});

	describe("documentExists", () => {
		it("should return true when document exists", async () => {
			mockExists.mockResolvedValue(true);

			const result = await service.documentExists("doc-1");
			expect(result).toBe(true);
			expect(mockExists).toHaveBeenCalledWith({
				index: "email_chunks_v1",
				id: "doc-1",
			});
		});

		it("should return false when document does not exist", async () => {
			mockExists.mockResolvedValue(false);

			const result = await service.documentExists("doc-1");
			expect(result).toBe(false);
		});

		it("should return false on error", async () => {
			mockExists.mockRejectedValue(new Error("Connection failed"));

			const result = await service.documentExists("doc-1");
			expect(result).toBe(false);
		});
	});

	describe("indexDocument", () => {
		it("should index a document successfully (created)", async () => {
			mockIndex.mockResolvedValue({ result: "created" });

			const result = await service.indexDocument("doc-1", {
				field: "value",
			});

			expect(result.success).toBe(true);
			expect(result.isUpdate).toBe(false);
		});

		it("should detect update when document existed", async () => {
			mockIndex.mockResolvedValue({ result: "updated" });

			const result = await service.indexDocument("doc-1", {
				field: "value",
			});

			expect(result.success).toBe(true);
			expect(result.isUpdate).toBe(true);
		});

		it("should return error on failure", async () => {
			mockIndex.mockRejectedValue(new Error("Index failed"));

			const result = await service.indexDocument("doc-1", {
				field: "value",
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("Index failed");
		});
	});

	describe("ensureIndex", () => {
		it("should skip creation if index already exists", async () => {
			mockIndicesExists.mockResolvedValue(true);

			await service.ensureIndex(768);

			expect(mockIndicesCreate).not.toHaveBeenCalled();
			expect(mockLogger.info).toHaveBeenCalledWith(
				"Index already exists",
				expect.any(Object),
			);
		});

		it("should create index when it does not exist", async () => {
			mockIndicesExists.mockResolvedValue(false);
			mockIndicesCreate.mockResolvedValue({});

			await service.ensureIndex(768);

			expect(mockIndicesCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					index: "email_chunks_v1",
					mappings: expect.objectContaining({
						properties: expect.objectContaining({
							vector: expect.objectContaining({
								type: "dense_vector",
								dims: 768,
								similarity: "cosine",
							}),
						}),
					}),
				}),
			);
		});

		it("should cache index existence check", async () => {
			mockIndicesExists.mockResolvedValue(true);

			await service.ensureIndex(768);
			await service.ensureIndex(768);
			await service.ensureIndex(768);

			// Should only check once
			expect(mockIndicesExists).toHaveBeenCalledTimes(1);
		});
	});

	describe("healthCheck", () => {
		it("should return true when cluster is healthy (green)", async () => {
			mockClusterHealth.mockResolvedValue({ status: "green" });

			const result = await service.healthCheck();
			expect(result).toBe(true);
		});

		it("should return true when cluster is yellow", async () => {
			mockClusterHealth.mockResolvedValue({ status: "yellow" });

			const result = await service.healthCheck();
			expect(result).toBe(true);
		});

		it("should return false when cluster is red", async () => {
			mockClusterHealth.mockResolvedValue({ status: "red" });

			const result = await service.healthCheck();
			expect(result).toBe(false);
		});

		it("should return false on connection error", async () => {
			mockClusterHealth.mockRejectedValue(new Error("Connection refused"));

			const result = await service.healthCheck();
			expect(result).toBe(false);
		});
	});

	describe("getIndexName", () => {
		it("should return configured index name", () => {
			expect(service.getIndexName()).toBe("email_chunks_v1");
		});
	});
});
