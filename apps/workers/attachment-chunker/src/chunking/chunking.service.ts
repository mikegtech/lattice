import { createHash } from "crypto";
import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { CHUNKING_CONFIG, type ChunkingConfig } from "./chunking.config.js";

export interface ChunkOptions {
	emailId: string;
	contentHash: string;
	attachmentId: string;
}

export interface GeneratedChunk {
	chunkId: string;
	chunkHash: string;
	chunkIndex: number;
	totalChunks: number;
	chunkText: string;
	charCount: number;
	tokenCountEstimate: number;
	chunkingVersion: string;
	normalizationVersion: string;
}

// Approximate chars per token (conservative estimate)
const CHARS_PER_TOKEN = 4;
const MIN_CHUNK_CHARS = 20;

export const CHUNKING_SERVICE = Symbol("CHUNKING_SERVICE");

@Injectable()
export class ChunkingService {
	constructor(
		@Inject(CHUNKING_CONFIG) private readonly config: ChunkingConfig,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	/**
	 * Chunk attachment text into embedding-ready segments.
	 * Returns chunks with deterministic hashes for idempotency.
	 */
	chunkText(text: string, options: ChunkOptions): GeneratedChunk[] {
		const normalized = this.normalizeText(text);

		if (normalized.length < MIN_CHUNK_CHARS) {
			this.logger.debug("Text too short to chunk", {
				email_id: options.emailId,
				attachment_id: options.attachmentId,
				char_count: normalized.length,
			});
			return [];
		}

		const targetChars = this.config.targetTokens * CHARS_PER_TOKEN;
		const maxChars = this.config.maxTokens * CHARS_PER_TOKEN;
		const overlapChars = this.config.overlapTokens * CHARS_PER_TOKEN;

		const rawChunks = this.splitIntoChunks(
			normalized,
			targetChars,
			maxChars,
			overlapChars,
		);

		const chunks = rawChunks.map((chunkText, index) => {
			const chunkHash = this.calculateChunkHash(
				chunkText,
				options.emailId,
				options.attachmentId,
				index,
			);

			return {
				chunkId: uuidv4(),
				chunkHash,
				chunkIndex: index,
				totalChunks: rawChunks.length,
				chunkText,
				charCount: chunkText.length,
				tokenCountEstimate: Math.ceil(chunkText.length / CHARS_PER_TOKEN),
				chunkingVersion: this.config.chunkingVersion,
				normalizationVersion: this.config.normalizationVersion,
			};
		});

		this.logger.debug("Chunking complete", {
			email_id: options.emailId,
			attachment_id: options.attachmentId,
			chunk_count: chunks.length,
			total_chars: normalized.length,
		});

		return chunks;
	}

	private normalizeText(text: string): string {
		return text
			.replace(/\r\n/g, "\n")
			.replace(/\r/g, "\n")
			.replace(/\t/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	private splitIntoChunks(
		text: string,
		targetChars: number,
		maxChars: number,
		overlapChars: number,
	): string[] {
		const chunks: string[] = [];
		let remaining = text;

		while (remaining.length > 0) {
			if (remaining.length <= maxChars) {
				const trimmed = remaining.trim();
				if (trimmed.length >= MIN_CHUNK_CHARS) {
					chunks.push(trimmed);
				}
				break;
			}

			// Find a good break point
			let breakPoint = targetChars;

			// Look for sentence boundary
			const sentenceEnd = remaining.lastIndexOf(". ", targetChars);
			if (sentenceEnd > targetChars * 0.5) {
				breakPoint = sentenceEnd + 1;
			} else {
				// Look for word boundary
				const wordEnd = remaining.lastIndexOf(" ", targetChars);
				if (wordEnd > targetChars * 0.5) {
					breakPoint = wordEnd;
				}
			}

			const chunkText = remaining.substring(0, breakPoint).trim();
			if (chunkText.length >= MIN_CHUNK_CHARS) {
				chunks.push(chunkText);
			}

			// Apply overlap - take last N chars from current chunk and prepend to remaining
			const nextStart = breakPoint;
			const overlapStart = Math.max(0, breakPoint - overlapChars);
			const overlap = remaining.substring(overlapStart, breakPoint);

			remaining = overlap + " " + remaining.substring(nextStart).trim();
			remaining = remaining.trim();

			// Safety limit to prevent infinite loops
			if (chunks.length > 1000) {
				this.logger.warn("Chunk limit reached");
				break;
			}
		}

		return chunks.filter((c) => c.length >= MIN_CHUNK_CHARS);
	}

	/**
	 * Calculate deterministic chunk hash for deduplication.
	 * Hash includes text + versions + attachment context.
	 */
	private calculateChunkHash(
		text: string,
		emailId: string,
		attachmentId: string,
		chunkIndex: number,
	): string {
		const content = [
			text,
			emailId,
			attachmentId,
			chunkIndex.toString(),
			this.config.normalizationVersion,
			this.config.chunkingVersion,
		].join("|");

		return createHash("sha256").update(content).digest("hex");
	}
}
