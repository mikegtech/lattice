import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import { EMBEDDING_CONFIG, type EmbeddingConfig } from "./embedding.config.js";
import {
	type BatchEmbeddingResult,
	EMBEDDING_PROVIDER,
	type EmbeddingInput,
	type EmbeddingProvider,
	type EmbeddingResult,
} from "./providers/embedding-provider.interface.js";

export const EMBEDDING_SERVICE = "EMBEDDING_SERVICE";

export interface EmbeddingRequest {
	chunkId: string;
	chunkHash: string;
	text: string;
}

export interface EmbeddingResponse {
	chunkId: string;
	chunkHash: string;
	vector: number[];
	model: string;
	dimensions: number;
	tokenCount?: number;
	error?: string;
}

/**
 * Embedding service that wraps the provider with batching and rate limiting
 */
@Injectable()
export class EmbeddingService {
	private requestCount = 0;
	private windowStart = Date.now();

	constructor(
		@Inject(EMBEDDING_CONFIG) private readonly config: EmbeddingConfig,
		@Inject(EMBEDDING_PROVIDER) private readonly provider: EmbeddingProvider,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	/**
	 * Get the embedding version for idempotency tracking
	 */
	get embeddingVersion(): string {
		return this.config.embeddingVersion;
	}

	/**
	 * Get the model identifier
	 */
	get model(): string {
		return this.provider.model;
	}

	/**
	 * Get vector dimensions
	 */
	get dimensions(): number {
		return this.provider.dimensions;
	}

	/**
	 * Embed a single chunk
	 */
	async embedSingle(request: EmbeddingRequest): Promise<EmbeddingResponse> {
		await this.enforceRateLimit();

		try {
			const result = await this.provider.embed(request.text);
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
			this.logger.error("Embedding failed", errorMsg, request.chunkId);
			return {
				chunkId: request.chunkId,
				chunkHash: request.chunkHash,
				vector: [],
				model: this.provider.model,
				dimensions: 0,
				error: errorMsg,
			};
		}
	}

	/**
	 * Embed multiple chunks in a batch
	 */
	async embedBatch(requests: EmbeddingRequest[]): Promise<EmbeddingResponse[]> {
		if (requests.length === 0) {
			return [];
		}

		// Split into batches based on config
		const batches = this.splitIntoBatches(requests, this.config.batchSize);
		const allResponses: EmbeddingResponse[] = [];

		for (const batch of batches) {
			await this.enforceRateLimit();

			const inputs: EmbeddingInput[] = batch.map((r) => ({
				id: r.chunkId,
				text: r.text,
			}));

			try {
				const results = await this.provider.embedBatch(inputs);

				// Map results back to responses
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
							model: this.provider.model,
							dimensions: 0,
							error: result.error,
						});
					}
				}
			} catch (error) {
				// If batch fails, mark all as failed
				const errorMsg =
					error instanceof Error ? error.message : "Unknown error";
				this.logger.error(
					"Batch embedding failed",
					errorMsg,
					JSON.stringify({ batchSize: batch.length }),
				);

				for (const request of batch) {
					allResponses.push({
						chunkId: request.chunkId,
						chunkHash: request.chunkHash,
						vector: [],
						model: this.provider.model,
						dimensions: 0,
						error: errorMsg,
					});
				}
			}
		}

		return allResponses;
	}

	/**
	 * Health check
	 */
	async healthCheck(): Promise<boolean> {
		return this.provider.healthCheck();
	}

	/**
	 * Split requests into batches
	 */
	private splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
		const batches: T[][] = [];
		for (let i = 0; i < items.length; i += batchSize) {
			batches.push(items.slice(i, i + batchSize));
		}
		return batches;
	}

	/**
	 * Enforce rate limiting
	 */
	private async enforceRateLimit(): Promise<void> {
		const now = Date.now();

		// Reset window if expired
		if (now - this.windowStart >= this.config.rateLimitWindowMs) {
			this.windowStart = now;
			this.requestCount = 0;
		}

		// Check if we've exceeded rate limit
		if (this.requestCount >= this.config.rateLimit) {
			const waitTime = this.config.rateLimitWindowMs - (now - this.windowStart);
			if (waitTime > 0) {
				this.logger.debug("Rate limit reached, waiting", { waitTime });
				await new Promise((resolve) => setTimeout(resolve, waitTime));
				this.windowStart = Date.now();
				this.requestCount = 0;
			}
		}

		this.requestCount++;
	}
}
