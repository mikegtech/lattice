import { Injectable } from "@nestjs/common";

export const TOKENIZER_SERVICE = "TOKENIZER_SERVICE";

/**
 * Token estimation service.
 *
 * TODO: For production accuracy, integrate with actual tokenizer (tiktoken for OpenAI,
 * or model-specific tokenizer). Current implementation uses approximate word-based estimation.
 *
 * The approximation is: ~0.75 tokens per word (or ~4 chars per token for English text).
 * This is a reasonable estimate for GPT-style models but will vary by language and content.
 */
@Injectable()
export class TokenizerService {
	/**
	 * Average characters per token for English text.
	 * GPT models average ~4 chars/token for English.
	 */
	private readonly CHARS_PER_TOKEN = 4;

	/**
	 * Estimate token count for a given text.
	 * Uses character-based approximation.
	 */
	estimateTokens(text: string): number {
		if (!text || text.length === 0) return 0;
		return Math.ceil(text.length / this.CHARS_PER_TOKEN);
	}

	/**
	 * Estimate character count for a given token target.
	 */
	tokensToChars(tokens: number): number {
		return tokens * this.CHARS_PER_TOKEN;
	}

	/**
	 * Split text into approximate token boundaries.
	 * Preserves word boundaries for clean splits.
	 */
	splitAtTokenBoundary(
		text: string,
		targetTokens: number,
	): { chunk: string; remaining: string } {
		const targetChars = this.tokensToChars(targetTokens);

		if (text.length <= targetChars) {
			return { chunk: text, remaining: "" };
		}

		// Find a good break point near the target
		let breakPoint = targetChars;

		// Look for paragraph break first (within 20% of target)
		const paragraphSearch = text.substring(
			Math.floor(targetChars * 0.8),
			Math.ceil(targetChars * 1.2),
		);
		const paragraphMatch = paragraphSearch.match(/\n\n/);
		if (paragraphMatch && paragraphMatch.index !== undefined) {
			breakPoint = Math.floor(targetChars * 0.8) + paragraphMatch.index + 2;
			return {
				chunk: text.substring(0, breakPoint).trim(),
				remaining: text.substring(breakPoint).trim(),
			};
		}

		// Look for sentence break
		const sentenceSearch = text.substring(
			Math.floor(targetChars * 0.8),
			Math.ceil(targetChars * 1.1),
		);
		const sentenceMatch = sentenceSearch.match(/[.!?]\s+/);
		if (sentenceMatch && sentenceMatch.index !== undefined) {
			breakPoint =
				Math.floor(targetChars * 0.8) +
				sentenceMatch.index +
				sentenceMatch[0].length;
			return {
				chunk: text.substring(0, breakPoint).trim(),
				remaining: text.substring(breakPoint).trim(),
			};
		}

		// Fall back to word boundary
		const wordBoundary = text.lastIndexOf(" ", targetChars);
		if (wordBoundary > targetChars * 0.5) {
			breakPoint = wordBoundary;
		}

		return {
			chunk: text.substring(0, breakPoint).trim(),
			remaining: text.substring(breakPoint).trim(),
		};
	}
}
