import type { TelemetryService } from "@lattice/worker-base";
import type {
	BatchEmbeddingResult,
	EmbeddingInput,
	EmbeddingProvider,
	EmbeddingResult,
} from "./embedding-provider.interface.js";

export interface OpenAIProviderConfig {
	apiKey: string;
	model: string;
	dimensions: number;
	timeoutMs: number;
}

export const OPENAI_CONFIG = "OPENAI_CONFIG";

interface OpenAIEmbeddingResponse {
	object: string;
	data: Array<{
		object: string;
		index: number;
		embedding: number[];
	}>;
	model: string;
	usage: {
		prompt_tokens: number;
		total_tokens: number;
	};
}

/**
 * OpenAI embedding provider using text-embedding-3-small.
 *
 * Features:
 * - Native 1536 dimensions (can request 768 for Milvus compatibility)
 * - 8,191 token context
 * - MTEB score: 62.3
 * - Full token usage metrics for Datadog LLM observability
 *
 * Cost: $0.02 per 1M tokens
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
	readonly name = "openai";
	readonly model: string;
	readonly dimensions: number;

	private static readonly API_URL = "https://api.openai.com/v1/embeddings";
	private static readonly COST_PER_MILLION_TOKENS = 0.02;

	constructor(
		private readonly config: OpenAIProviderConfig,
		private readonly telemetry: TelemetryService,
	) {
		this.model = config.model;
		this.dimensions = config.dimensions;
	}

	async embed(text: string): Promise<EmbeddingResult> {
		const results = await this.embedBatch([{ id: "single", text }]);
		const result = results[0];

		if (!result || result.error || !result.result) {
			throw new Error(result?.error ?? "Embedding failed");
		}

		return result.result;
	}

	async embedBatch(inputs: EmbeddingInput[]): Promise<BatchEmbeddingResult[]> {
		if (inputs.length === 0) {
			return [];
		}

		const startTime = Date.now();
		const texts = inputs.map((i) => i.text);

		try {
			const response = await fetch(OpenAIEmbeddingProvider.API_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.config.apiKey}`,
				},
				body: JSON.stringify({
					model: this.config.model,
					input: texts,
					dimensions: this.config.dimensions,
				}),
				signal: AbortSignal.timeout(this.config.timeoutMs),
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				const errorMsg =
					(errorData as { error?: { message?: string } })?.error?.message ??
					`HTTP ${response.status}`;
				throw new Error(`OpenAI API error: ${errorMsg}`);
			}

			const data = (await response.json()) as OpenAIEmbeddingResponse;
			const latencyMs = Date.now() - startTime;
			const totalTokens = data.usage?.total_tokens ?? 0;

			// Emit comprehensive telemetry for Datadog LLM Observability
			this.emitTelemetry(texts, latencyMs, totalTokens, true);

			// Map embeddings to results (OpenAI returns in same order as input)
			return inputs.map((input, index) => {
				const item = data.data[index];
				if (!item) {
					return {
						id: input.id,
						result: null,
						error: `No embedding returned for index ${index}`,
					};
				}
				return {
					id: input.id,
					result: {
						vector: item.embedding,
						model: data.model,
						dimensions: this.dimensions,
						tokenCount: Math.floor(totalTokens / texts.length),
					},
				};
			});
		} catch (error) {
			const latencyMs = Date.now() - startTime;
			this.emitTelemetry(texts, latencyMs, 0, false);

			const errorMsg = error instanceof Error ? error.message : String(error);

			// Return errors for all inputs
			return inputs.map((input) => ({
				id: input.id,
				result: null,
				error: errorMsg,
			}));
		}
	}

	async healthCheck(): Promise<boolean> {
		// OpenAI doesn't have a health endpoint, try a minimal embedding
		try {
			const response = await fetch(OpenAIEmbeddingProvider.API_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.config.apiKey}`,
				},
				body: JSON.stringify({
					model: this.config.model,
					input: ["health check"],
					dimensions: this.dimensions,
				}),
				signal: AbortSignal.timeout(5000),
			});

			return response.ok;
		} catch {
			return false;
		}
	}

	private emitTelemetry(
		texts: string[],
		latencyMs: number,
		totalTokens: number,
		success: boolean,
	): void {
		this.telemetry.timing("lattice.embedding.latency_ms", latencyMs, {
			provider: this.name,
			model: this.model,
			stage: "embed",
		});

		this.telemetry.increment("lattice.embedding.requests", 1, {
			provider: this.name,
			model: this.model,
			success: String(success),
		});

		if (success) {
			this.telemetry.gauge("lattice.embedding.batch_size", texts.length, {
				provider: this.name,
			});

			// Actual token count from API response (for Datadog LLM Observability)
			this.telemetry.increment("lattice.embedding.tokens", totalTokens, {
				provider: this.name,
				model: this.model,
			});

			// Cost tracking
			const costUsd =
				(totalTokens / 1_000_000) *
				OpenAIEmbeddingProvider.COST_PER_MILLION_TOKENS;
			this.telemetry.gauge("lattice.embedding.cost_usd", costUsd, {
				provider: this.name,
				model: this.model,
			});

			this.telemetry.gauge("lattice.embedding.dimensions", this.dimensions, {
				provider: this.name,
				model: this.model,
			});
		}
	}
}
