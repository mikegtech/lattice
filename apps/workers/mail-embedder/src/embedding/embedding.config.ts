import { Injectable } from "@nestjs/common";

export const EMBEDDING_CONFIG = "EMBEDDING_CONFIG";

/**
 * Embedding configuration loaded from environment variables
 */
@Injectable()
export class EmbeddingConfig {
	/** Embedding provider to use */
	readonly provider: string;

	/** Embedding model identifier */
	readonly model: string;

	/** Embedding version for tracking */
	readonly embeddingVersion: string;

	/** Maximum batch size for embedding requests */
	readonly batchSize: number;

	/** Rate limit: max requests per second */
	readonly rateLimit: number;

	/** Rate limit window in milliseconds */
	readonly rateLimitWindowMs: number;

	/** Retry count for failed embeddings */
	readonly maxRetries: number;

	/** Retry backoff in milliseconds */
	readonly retryBackoffMs: number;

	constructor() {
		this.provider = process.env["EMBEDDING_PROVIDER"] ?? "local-stub";
		this.model = process.env["EMBEDDING_MODEL"] ?? "local-stub-v1";
		this.embeddingVersion = process.env["EMBEDDING_VERSION"] ?? "v1";
		this.batchSize = Number.parseInt(
			process.env["EMBEDDING_BATCH_SIZE"] ?? "10",
			10,
		);
		this.rateLimit = Number.parseInt(
			process.env["EMBEDDING_RATE_LIMIT"] ?? "100",
			10,
		);
		this.rateLimitWindowMs = Number.parseInt(
			process.env["EMBEDDING_RATE_LIMIT_WINDOW_MS"] ?? "1000",
			10,
		);
		this.maxRetries = Number.parseInt(
			process.env["EMBEDDING_MAX_RETRIES"] ?? "3",
			10,
		);
		this.retryBackoffMs = Number.parseInt(
			process.env["EMBEDDING_RETRY_BACKOFF_MS"] ?? "1000",
			10,
		);
	}
}
