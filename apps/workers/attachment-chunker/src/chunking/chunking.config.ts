import { WORKER_CONFIG, type WorkerConfig } from "@lattice/worker-base";
import type { FactoryProvider } from "@nestjs/common";

export interface ChunkingConfig {
	/** Target tokens per chunk */
	targetTokens: number;
	/** Overlap tokens between chunks */
	overlapTokens: number;
	/** Maximum tokens per chunk */
	maxTokens: number;
	/** Chunking algorithm version */
	chunkingVersion: string;
	/** Text normalization version */
	normalizationVersion: string;
}

export const CHUNKING_CONFIG = Symbol("CHUNKING_CONFIG");

export const ChunkingConfigProvider: FactoryProvider<ChunkingConfig> = {
	provide: CHUNKING_CONFIG,
	useFactory: (config: WorkerConfig): ChunkingConfig => ({
		targetTokens: Number.parseInt(
			process.env["CHUNK_TARGET_TOKENS"] ?? "400",
			10,
		),
		overlapTokens: Number.parseInt(
			process.env["CHUNK_OVERLAP_TOKENS"] ?? "50",
			10,
		),
		maxTokens: Number.parseInt(process.env["CHUNK_MAX_TOKENS"] ?? "512", 10),
		chunkingVersion: process.env["CHUNKING_VERSION"] ?? "v1",
		normalizationVersion: process.env["NORMALIZATION_VERSION"] ?? "v1",
	}),
	inject: [WORKER_CONFIG],
};
