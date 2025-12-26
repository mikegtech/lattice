import { createHash } from "crypto";
import { Injectable } from "@nestjs/common";
import type {
	BatchEmbeddingResult,
	EmbeddingInput,
	EmbeddingProvider,
	EmbeddingResult,
} from "./embedding-provider.interface.js";

/**
 * Local stub embedding provider for development/testing.
 * Generates deterministic pseudo-embeddings based on text hash.
 *
 * This is NOT suitable for production - replace with OpenAI, Cohere, etc.
 */
@Injectable()
export class LocalStubEmbeddingProvider implements EmbeddingProvider {
	readonly name = "local-stub";
	readonly model = "local-stub-v1";
	readonly dimensions = 384; // Common small embedding size

	/**
	 * Generate a deterministic pseudo-embedding from text.
	 * Uses SHA-256 hash to create reproducible vectors.
	 */
	async embed(text: string): Promise<EmbeddingResult> {
		// Simulate some latency
		await this.simulateLatency();

		const vector = this.generateDeterministicVector(text);

		return {
			vector,
			model: this.model,
			dimensions: this.dimensions,
			tokenCount: Math.ceil(text.length / 4), // Rough estimate
		};
	}

	/**
	 * Generate embeddings for a batch of texts
	 */
	async embedBatch(inputs: EmbeddingInput[]): Promise<BatchEmbeddingResult[]> {
		// Simulate batch latency (less than sum of individual)
		await this.simulateLatency(inputs.length * 5);

		const results: BatchEmbeddingResult[] = [];

		for (const input of inputs) {
			try {
				const vector = this.generateDeterministicVector(input.text);
				results.push({
					id: input.id,
					result: {
						vector,
						model: this.model,
						dimensions: this.dimensions,
						tokenCount: Math.ceil(input.text.length / 4),
					},
				});
			} catch (error) {
				results.push({
					id: input.id,
					result: null,
					error: error instanceof Error ? error.message : "Unknown error",
				});
			}
		}

		return results;
	}

	/**
	 * Health check - always healthy for stub
	 */
	async healthCheck(): Promise<boolean> {
		return true;
	}

	/**
	 * Generate a deterministic vector from text using hash
	 */
	private generateDeterministicVector(text: string): number[] {
		// Create multiple hashes to fill the vector
		const vector: number[] = [];
		let seed = text;

		while (vector.length < this.dimensions) {
			const hash = createHash("sha256").update(seed).digest();

			// Convert hash bytes to floats between -1 and 1
			for (
				let i = 0;
				i < hash.length && vector.length < this.dimensions;
				i += 4
			) {
				// Read 4 bytes as uint32 and normalize to [-1, 1]
				const uint32 = hash.readUInt32LE(i);
				const normalized = (uint32 / 0xffffffff) * 2 - 1;
				vector.push(normalized);
			}

			// Use previous hash as seed for next iteration
			seed = hash.toString("hex");
		}

		// Normalize vector to unit length (L2 normalization)
		const magnitude = Math.sqrt(
			vector.reduce((sum, val) => sum + val * val, 0),
		);
		return vector.map((val) => val / magnitude);
	}

	/**
	 * Simulate API latency
	 */
	private simulateLatency(ms = 10): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
