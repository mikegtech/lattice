import type { LoggerService } from "@lattice/worker-base";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MilvusConfig } from "./milvus.config.js";
import { MilvusService, type VectorRecord } from "./milvus.service.js";

// Mock the Milvus client
vi.mock("@zilliz/milvus2-sdk-node", () => ({
	MilvusClient: vi.fn().mockImplementation(() => ({
		checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
		hasCollection: vi.fn().mockResolvedValue({ value: true }),
		createCollection: vi.fn().mockResolvedValue({}),
		createIndex: vi.fn().mockResolvedValue({}),
		loadCollection: vi.fn().mockResolvedValue({}),
		query: vi.fn().mockResolvedValue({ data: [] }),
		upsert: vi.fn().mockResolvedValue({
			status: { error_code: "Success" },
			succ_index: [0],
		}),
		closeConnection: vi.fn().mockResolvedValue({}),
	})),
	DataType: {
		VarChar: 21,
		Int64: 5,
		FloatVector: 101,
	},
}));

const createMockLogger = (): LoggerService =>
	({
		log: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}) as unknown as LoggerService;

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

describe("MilvusService", () => {
	let service: MilvusService;
	let mockLogger: LoggerService;
	let mockConfig: MilvusConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		mockLogger = createMockLogger();
		mockConfig = createMilvusConfig(384);

		service = new MilvusService(mockConfig, mockLogger);
	});

	describe("generatePK", () => {
		it("should generate deterministic PKs", () => {
			const pk1 = MilvusService.generatePK("email-1", "hash-1", "v1");
			const pk2 = MilvusService.generatePK("email-1", "hash-1", "v1");

			expect(pk1).toBe(pk2);
			expect(pk1).toHaveLength(64); // SHA256 hex
		});

		it("should generate unique PKs for different inputs", () => {
			const pks = [
				MilvusService.generatePK("email-1", "hash-1", "v1"),
				MilvusService.generatePK("email-2", "hash-1", "v1"),
				MilvusService.generatePK("email-1", "hash-2", "v1"),
				MilvusService.generatePK("email-1", "hash-1", "v2"),
			];

			const uniquePks = new Set(pks);
			expect(uniquePks.size).toBe(4);
		});

		it("should include all components in hash", () => {
			// Changing any component should change the hash
			const base = MilvusService.generatePK("a", "b", "c");
			const diffEmail = MilvusService.generatePK("x", "b", "c");
			const diffHash = MilvusService.generatePK("a", "x", "c");
			const diffVersion = MilvusService.generatePK("a", "b", "x");

			expect(base).not.toBe(diffEmail);
			expect(base).not.toBe(diffHash);
			expect(base).not.toBe(diffVersion);
		});
	});

	describe("ensureCollection", () => {
		it("should skip creation if collection already exists", async () => {
			await service.ensureCollection();

			// Should log that collection exists
			expect(mockLogger.info).toHaveBeenCalledWith(
				"Collection already exists",
				expect.any(Object),
			);
		});

		it("should cache collection existence check", async () => {
			await service.ensureCollection();
			await service.ensureCollection();
			await service.ensureCollection();

			// Should only connect once
			expect(mockLogger.info).toHaveBeenCalledWith(
				"Connecting to Milvus",
				expect.any(Object),
			);
		});
	});

	describe("upsert", () => {
		it("should return empty array for empty input", async () => {
			const result = await service.upsert([]);
			expect(result).toEqual([]);
		});

		it("should upsert valid vectors successfully", async () => {
			const vector = new Array(384).fill(0.1);
			const record: VectorRecord = {
				pk: MilvusService.generatePK("email-1", "hash-1", "v1"),
				tenantId: "tenant-1",
				accountId: "account-1",
				alias: "user@example.com",
				emailId: "email-1",
				chunkHash: "hash-1",
				embeddingVersion: "v1",
				embeddingModel: "all-MiniLM-L6-v2",
				sectionType: "body",
				emailTimestamp: Date.now() / 1000,
				vector,
			};

			const result = await service.upsert([record]);

			expect(result).toHaveLength(1);
			expect(result[0]!.success).toBe(true);
			expect(result[0]!.pk).toBe(record.pk);
		});

		it("should fail on dimension mismatch", async () => {
			const wrongDimensionVector = new Array(512).fill(0.1);
			const record: VectorRecord = {
				pk: MilvusService.generatePK("email-1", "hash-1", "v1"),
				tenantId: "tenant-1",
				accountId: "account-1",
				emailId: "email-1",
				chunkHash: "hash-1",
				embeddingVersion: "v1",
				embeddingModel: "all-MiniLM-L6-v2",
				vector: wrongDimensionVector,
			};

			const result = await service.upsert([record]);

			expect(result).toHaveLength(1);
			expect(result[0]!.success).toBe(false);
			expect(result[0]!.error).toContain("Dimension mismatch");
		});

		it("should handle optional fields", async () => {
			const vector = new Array(384).fill(0.1);
			const record: VectorRecord = {
				pk: MilvusService.generatePK("email-1", "hash-1", "v1"),
				tenantId: "tenant-1",
				accountId: "account-1",
				emailId: "email-1",
				chunkHash: "hash-1",
				embeddingVersion: "v1",
				embeddingModel: "all-MiniLM-L6-v2",
				// No alias, sectionType, or emailTimestamp
				vector,
			};

			const result = await service.upsert([record]);

			expect(result).toHaveLength(1);
			expect(result[0]!.success).toBe(true);
		});
	});

	describe("getExistingPKs", () => {
		it("should return empty set for empty input", async () => {
			const result = await service.getExistingPKs([]);
			expect(result).toEqual(new Set());
		});

		it("should query Milvus for existing PKs", async () => {
			const pks = ["pk-1", "pk-2", "pk-3"];
			const result = await service.getExistingPKs(pks);

			// Mock returns empty data, so should be empty set
			expect(result).toEqual(new Set());
		});
	});

	describe("healthCheck", () => {
		it("should return true when Milvus is healthy", async () => {
			const result = await service.healthCheck();
			expect(result).toBe(true);
		});
	});
});
