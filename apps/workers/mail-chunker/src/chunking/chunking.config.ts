import { Injectable } from "@nestjs/common";

/**
 * Chunking configuration loaded from environment variables
 */
@Injectable()
export class ChunkingConfig {
	/** Target chunk size in tokens */
	readonly targetTokens: number;

	/** Overlap between chunks in tokens */
	readonly overlapTokens: number;

	/** Maximum chunk size (hard limit) */
	readonly maxTokens: number;

	/** Chunking algorithm version */
	readonly chunkingVersion: string;

	/** Text normalization version */
	readonly normalizationVersion: string;

	constructor() {
		this.targetTokens = Number.parseInt(
			process.env["CHUNK_TARGET_TOKENS"] ?? "400",
			10,
		);
		this.overlapTokens = Number.parseInt(
			process.env["CHUNK_OVERLAP_TOKENS"] ?? "50",
			10,
		);
		this.maxTokens = Number.parseInt(
			process.env["CHUNK_MAX_TOKENS"] ?? "512",
			10,
		);
		this.chunkingVersion = process.env["CHUNKING_VERSION"] ?? "v1";
		this.normalizationVersion = process.env["NORMALIZATION_VERSION"] ?? "v1";
	}
}
