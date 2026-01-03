import type { TelemetryService } from "@lattice/worker-base";
import type {
	BatchEmbeddingResult,
	EmbeddingInput,
	EmbeddingProvider,
	EmbeddingResult,
} from "./embedding-provider.interface.js";

export interface E5ProviderConfig {
	endpoint: string;
	prefix: string;
	timeoutMs: number;
}

export const E5_CONFIG = "E5_CONFIG";

interface E5Response {
	embeddings: number[][];
	model: string;
	dimensions: number;
}

/**
 * E5 embedding provider using local e5-base-v2 service.
 *
 * Features:
 * - 768 dimensions
 * - 512 token context (shorter than Nomic)
 * - MTEB score: 58.5
 *
 * Prefix conventions:
 * - "passage: " for indexing documents/chunks
 * - "query: " for search queries
 *
 * Note: This is the legacy provider. Prefer Nomic for new deployments.
 */
export class E5EmbeddingProvider implements EmbeddingProvider {
	readonly name = "e5";
	readonly model = "e5-base-v2";
	readonly dimensions = 768;

	constructor(
		private readonly config: E5ProviderConfig,
		private readonly telemetry: TelemetryService,
	) {}

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
			const response = await fetch(`${this.config.endpoint}/embed`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					texts,
					prefix: this.config.prefix,
				}),
				signal: AbortSignal.timeout(this.config.timeoutMs),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`E5 API error: ${response.status} - ${errorText}`);
			}

			const data = (await response.json()) as E5Response;
			const latencyMs = Date.now() - startTime;

			// Emit telemetry
			this.emitTelemetry(texts, latencyMs, true);

			// Map embeddings to results
			return inputs.map((input, index) => {
				const vector = data.embeddings[index];
				if (!vector) {
					return {
						id: input.id,
						result: null,
						error: `No embedding returned for index ${index}`,
					};
				}
				return {
					id: input.id,
					result: {
						vector,
						model: data.model,
						dimensions: data.dimensions,
						tokenCount: this.estimateTokens(input.text),
					},
				};
			});
		} catch (error) {
			const latencyMs = Date.now() - startTime;
			this.emitTelemetry(texts, latencyMs, false);

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
		try {
			const response = await fetch(`${this.config.endpoint}/health`, {
				signal: AbortSignal.timeout(5000),
			});

			if (!response.ok) return false;

			const data = (await response.json()) as { status?: string };
			return data.status === "healthy";
		} catch {
			return false;
		}
	}

	private emitTelemetry(
		texts: string[],
		latencyMs: number,
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

			const estimatedTokens = texts.reduce(
				(sum, t) => sum + this.estimateTokens(t),
				0,
			);
			this.telemetry.increment("lattice.embedding.tokens", estimatedTokens, {
				provider: this.name,
				model: this.model,
			});

			this.telemetry.gauge("lattice.embedding.dimensions", this.dimensions, {
				provider: this.name,
				model: this.model,
			});
		}
	}

	private estimateTokens(text: string): number {
		// Rough estimate: ~4 characters per token
		return Math.ceil(text.length / 4);
	}
}
