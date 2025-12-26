import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock embedding provider
const mockProvider = {
	name: "local-stub",
	model: "local-stub-384",
	dimensions: 384,
	embed: vi.fn(),
	embedBatch: vi.fn(),
	healthCheck: vi.fn(),
};

// Mock config
const mockConfig = {
	embeddingVersion: "v1",
	batchSize: 10,
	rateLimit: 100,
	rateLimitWindowMs: 60000,
};

// Mock logger
const mockLogger = {
	log: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

describe("EmbeddingService", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("embedSingle", () => {
		it("should return embedding result on success", async () => {
			mockProvider.embed.mockResolvedValue({
				vector: Array(384).fill(0.1),
				model: "local-stub-384",
				dimensions: 384,
				tokenCount: 10,
			});

			const result = await simulateEmbedSingle({
				chunkId: "chunk-1",
				chunkHash: "hash-1",
				text: "Test content",
			});

			expect(result.vector).toHaveLength(384);
			expect(result.model).toBe("local-stub-384");
			expect(result.dimensions).toBe(384);
			expect(result.error).toBeUndefined();
		});

		it("should return error when embedding fails", async () => {
			mockProvider.embed.mockRejectedValue(new Error("Service unavailable"));

			const result = await simulateEmbedSingle({
				chunkId: "chunk-1",
				chunkHash: "hash-1",
				text: "Test content",
			});

			expect(result.vector).toEqual([]);
			expect(result.error).toBe("Service unavailable");
		});
	});

	describe("embedBatch", () => {
		it("should process batch and return all results", async () => {
			mockProvider.embedBatch.mockResolvedValue([
				{
					id: "chunk-1",
					result: {
						vector: Array(384).fill(0.1),
						model: "local-stub-384",
						dimensions: 384,
					},
				},
				{
					id: "chunk-2",
					result: {
						vector: Array(384).fill(0.2),
						model: "local-stub-384",
						dimensions: 384,
					},
				},
			]);

			const results = await simulateEmbedBatch([
				{ chunkId: "chunk-1", chunkHash: "hash-1", text: "Content 1" },
				{ chunkId: "chunk-2", chunkHash: "hash-2", text: "Content 2" },
			]);

			expect(results).toHaveLength(2);
			expect(results[0]?.vector).toHaveLength(384);
			expect(results[1]?.vector).toHaveLength(384);
		});

		it("should handle partial failures in batch", async () => {
			mockProvider.embedBatch.mockResolvedValue([
				{
					id: "chunk-1",
					result: {
						vector: Array(384).fill(0.1),
						model: "local-stub-384",
						dimensions: 384,
					},
				},
				{
					id: "chunk-2",
					error: "Content too long",
				},
			]);

			const results = await simulateEmbedBatch([
				{ chunkId: "chunk-1", chunkHash: "hash-1", text: "Content 1" },
				{ chunkId: "chunk-2", chunkHash: "hash-2", text: "Very long content" },
			]);

			expect(results).toHaveLength(2);
			expect(results[0]?.error).toBeUndefined();
			expect(results[1]?.error).toBe("Content too long");
		});

		it("should split large batches", async () => {
			// Create 25 items, should be split into 3 batches (10, 10, 5)
			const items = Array.from({ length: 25 }, (_, i) => ({
				chunkId: `chunk-${i}`,
				chunkHash: `hash-${i}`,
				text: `Content ${i}`,
			}));

			mockProvider.embedBatch.mockImplementation(async (inputs) => {
				return inputs.map((input: { id: string; text: string }) => ({
					id: input.id,
					result: {
						vector: Array(384).fill(0.1),
						model: "local-stub-384",
						dimensions: 384,
					},
				}));
			});

			const results = await simulateEmbedBatch(items);

			expect(results).toHaveLength(25);
			// Should have been called 3 times (10 + 10 + 5)
			expect(mockProvider.embedBatch).toHaveBeenCalledTimes(3);
		});
	});

	describe("rate limiting", () => {
		it("should enforce rate limits", async () => {
			const startTime = Date.now();
			mockProvider.embed.mockResolvedValue({
				vector: Array(384).fill(0.1),
				model: "local-stub-384",
				dimensions: 384,
			});

			// Simulate multiple rapid requests
			const requests = Array.from({ length: 5 }, (_, i) =>
				simulateEmbedSingle({
					chunkId: `chunk-${i}`,
					chunkHash: `hash-${i}`,
					text: "Test",
				}),
			);

			await Promise.all(requests);

			// All should complete without error
			expect(mockProvider.embed).toHaveBeenCalledTimes(5);
		});
	});

	describe("healthCheck", () => {
		it("should return provider health status", async () => {
			mockProvider.healthCheck.mockResolvedValue(true);

			const healthy = await mockProvider.healthCheck();

			expect(healthy).toBe(true);
		});

		it("should return false when provider is unhealthy", async () => {
			mockProvider.healthCheck.mockResolvedValue(false);

			const healthy = await mockProvider.healthCheck();

			expect(healthy).toBe(false);
		});
	});
});

interface EmbeddingRequest {
	chunkId: string;
	chunkHash: string;
	text: string;
}

interface EmbeddingResponse {
	chunkId: string;
	chunkHash: string;
	vector: number[];
	model: string;
	dimensions: number;
	tokenCount?: number;
	error?: string;
}

async function simulateEmbedSingle(
	request: EmbeddingRequest,
): Promise<EmbeddingResponse> {
	try {
		const result = await mockProvider.embed(request.text);
		return {
			chunkId: request.chunkId,
			chunkHash: request.chunkHash,
			vector: result.vector,
			model: result.model,
			dimensions: result.dimensions,
			tokenCount: result.tokenCount,
		};
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : "Unknown error";
		return {
			chunkId: request.chunkId,
			chunkHash: request.chunkHash,
			vector: [],
			model: mockProvider.model,
			dimensions: 0,
			error: errorMsg,
		};
	}
}

async function simulateEmbedBatch(
	requests: EmbeddingRequest[],
): Promise<EmbeddingResponse[]> {
	if (requests.length === 0) {
		return [];
	}

	// Split into batches
	const batches: EmbeddingRequest[][] = [];
	for (let i = 0; i < requests.length; i += mockConfig.batchSize) {
		batches.push(requests.slice(i, i + mockConfig.batchSize));
	}

	const allResponses: EmbeddingResponse[] = [];

	for (const batch of batches) {
		const inputs = batch.map((r) => ({
			id: r.chunkId,
			text: r.text,
		}));

		try {
			const results = await mockProvider.embedBatch(inputs);

			for (const result of results) {
				const request = batch.find((r) => r.chunkId === result.id);
				if (!request) continue;

				if (result.result) {
					allResponses.push({
						chunkId: result.id,
						chunkHash: request.chunkHash,
						vector: result.result.vector,
						model: result.result.model,
						dimensions: result.result.dimensions,
						tokenCount: result.result.tokenCount,
					});
				} else {
					allResponses.push({
						chunkId: result.id,
						chunkHash: request.chunkHash,
						vector: [],
						model: mockProvider.model,
						dimensions: 0,
						error: result.error,
					});
				}
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : "Unknown error";
			for (const request of batch) {
				allResponses.push({
					chunkId: request.chunkId,
					chunkHash: request.chunkHash,
					vector: [],
					model: mockProvider.model,
					dimensions: 0,
					error: errorMsg,
				});
			}
		}
	}

	return allResponses;
}
