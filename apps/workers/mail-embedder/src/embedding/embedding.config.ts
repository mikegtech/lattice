import { Injectable } from "@nestjs/common";

export const EMBEDDING_CONFIG = "EMBEDDING_CONFIG";

export type EmbeddingProviderType = "nomic" | "e5" | "openai" | "local-stub";

/**
 * Embedding configuration loaded from environment variables
 */
@Injectable()
export class EmbeddingConfig {
	/** Embedding provider to use */
	readonly provider: EmbeddingProviderType;

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

	/** Request timeout in milliseconds */
	readonly timeoutMs: number;

	// Nomic provider config (port 8001 - primary)
	readonly nomicEndpoint: string;
	readonly nomicPrefix: string;

	// E5 provider config (port 8000 - legacy)
	readonly e5Endpoint: string;
	readonly e5Prefix: string;

	// OpenAI provider config (for Datadog challenge)
	readonly openaiApiKey: string;
	readonly openaiModel: string;
	readonly openaiDimensions: number;

	constructor() {
		const providerEnv = process.env["EMBEDDING_PROVIDER"] ?? "local-stub";
		this.provider = this.validateProvider(providerEnv);
		this.model = process.env["EMBEDDING_MODEL"] ?? this.getDefaultModel();
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
		this.timeoutMs = Number.parseInt(
			process.env["EMBEDDING_TIMEOUT_MS"] ?? "30000",
			10,
		);

		// Nomic config (port 8001 - primary)
		this.nomicEndpoint =
			process.env["NOMIC_ENDPOINT"] ?? "http://dataops.trupryce.ai:8001";
		this.nomicPrefix = process.env["NOMIC_PREFIX"] ?? "search_document: ";

		// E5 config (port 8000 - legacy)
		this.e5Endpoint =
			process.env["E5_ENDPOINT"] ?? "http://dataops.trupryce.ai:8000";
		this.e5Prefix = process.env["E5_PREFIX"] ?? "passage: ";

		// OpenAI config
		this.openaiApiKey = process.env["OPENAI_API_KEY"] ?? "";
		this.openaiModel = process.env["OPENAI_MODEL"] ?? "text-embedding-3-small";
		this.openaiDimensions = Number.parseInt(
			process.env["OPENAI_DIMENSIONS"] ?? "768",
			10,
		);
	}

	private validateProvider(provider: string): EmbeddingProviderType {
		const validProviders: EmbeddingProviderType[] = [
			"nomic",
			"e5",
			"openai",
			"local-stub",
		];
		if (validProviders.includes(provider as EmbeddingProviderType)) {
			return provider as EmbeddingProviderType;
		}
		console.warn(
			`Unknown embedding provider: ${provider}, falling back to local-stub`,
		);
		return "local-stub";
	}

	private getDefaultModel(): string {
		switch (this.provider) {
			case "nomic":
				return "nomic-embed-text-v1.5";
			case "e5":
				return "e5-base-v2";
			case "openai":
				return "text-embedding-3-small";
			default:
				return "local-stub-v1";
		}
	}
}
