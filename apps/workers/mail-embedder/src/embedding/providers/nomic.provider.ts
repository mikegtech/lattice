import type { TelemetryService } from "@lattice/worker-base";
import type {
	BatchEmbeddingResult,
	EmbeddingInput,
	EmbeddingProvider,
	EmbeddingResult,
} from "./embedding-provider.interface.js";

export interface NomicProviderConfig {
	endpoint: string;
	prefix: string;
	timeoutMs: number;
}

export const NOMIC_CONFIG = "NOMIC_CONFIG";

interface NomicResponse {
	embeddings: number[][];
	model: string;
	dimensions: number;
	latency_ms?: number;
}

/**
 * Nomic embedding provider using local nomic-embed-text-v1.5 service.
 *
 * Features:
 * - 768 dimensions
 * - 8,192 token context (16x longer than E5)
 * - Matryoshka embeddings support
 * - MTEB score: 62.0
 *
 * Prefix conventions:
 * - "search_document: " for indexing documents/chunks
 * - "search_query: " for search queries
 */
export class NomicEmbeddingProvider implements EmbeddingProvider {
	readonly name = "nomic";
	readonly model = "nomic-embed-text-v1.5";
	readonly dimensions = 768;

	constructor(
		private readonly config: NomicProviderConfig,
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
				throw new Error(`Nomic API error: ${response.status} - ${errorText}`);
			}

			const data = (await response.json()) as NomicResponse;
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
