import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChunkingConfig } from "../chunking/chunking.config.js";
import { ChunkingService } from "../chunking/chunking.service.js";
import { SectionClassifierService } from "../chunking/section-classifier.service.js";
import { TokenizerService } from "../chunking/tokenizer.service.js";

// Mock logger
const mockLogger = {
	log: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

describe("ChunkingService", () => {
	let service: ChunkingService;
	let config: ChunkingConfig;
	let tokenizer: TokenizerService;
	let classifier: SectionClassifierService;

	beforeEach(() => {
		// Set env vars for config
		process.env["CHUNK_TARGET_TOKENS"] = "100";
		process.env["CHUNK_OVERLAP_TOKENS"] = "20";
		process.env["CHUNK_MAX_TOKENS"] = "150";
		process.env["CHUNKING_VERSION"] = "v1";
		process.env["NORMALIZATION_VERSION"] = "v1";

		config = new ChunkingConfig();
		tokenizer = new TokenizerService();
		classifier = new SectionClassifierService();
		service = new ChunkingService(
			config,
			tokenizer,
			classifier,
			mockLogger as any,
		);
	});

	describe("determinism", () => {
		it("should produce identical chunk hashes for identical input", () => {
			const input = {
				emailId: "test-email-123",
				contentHash: "abc123",
				textNormalized: "This is a test email body with some content.",
				subject: "Test Subject",
			};

			const chunks1 = service.chunkEmail(input);
			const chunks2 = service.chunkEmail(input);

			expect(chunks1.length).toBe(chunks2.length);
			expect(chunks1.map((c) => c.chunkHash)).toEqual(
				chunks2.map((c) => c.chunkHash),
			);
		});

		it("should produce different hashes for different text", () => {
			const input1 = {
				emailId: "test-email-123",
				contentHash: "abc123",
				textNormalized: "First email content.",
			};

			const input2 = {
				emailId: "test-email-123",
				contentHash: "abc123",
				textNormalized: "Second email content.",
			};

			const chunks1 = service.chunkEmail(input1);
			const chunks2 = service.chunkEmail(input2);

			expect(chunks1[0]?.chunkHash).not.toBe(chunks2[0]?.chunkHash);
		});

		it("should include versioning in hash calculation", () => {
			const text = "Same text content";
			const hash1 = service.calculateChunkHash(text);

			// Change version
			process.env["CHUNKING_VERSION"] = "v2";
			const newConfig = new ChunkingConfig();
			const newService = new ChunkingService(
				newConfig,
				tokenizer,
				classifier,
				mockLogger as any,
			);
			const hash2 = newService.calculateChunkHash(text);

			expect(hash1).not.toBe(hash2);
		});
	});

	describe("chunking behavior", () => {
		it("should create single chunk for short content", () => {
			const input = {
				emailId: "test-email-123",
				contentHash: "abc123",
				textNormalized: "Short email.",
			};

			const chunks = service.chunkEmail(input);

			expect(chunks.length).toBe(1);
			expect(chunks[0]?.chunkText).toBe("Short email.");
			expect(chunks[0]?.sourceType).toBe("body");
			expect(chunks[0]?.sectionType).toBe("body");
		});

		it("should create multiple chunks for long content", () => {
			// Create content longer than target tokens (~400 chars at 4 chars/token)
			const longContent = "Lorem ipsum dolor sit amet. ".repeat(30);

			const input = {
				emailId: "test-email-123",
				contentHash: "abc123",
				textNormalized: longContent,
			};

			const chunks = service.chunkEmail(input);

			expect(chunks.length).toBeGreaterThan(1);
			chunks.forEach((chunk, i) => {
				expect(chunk.chunkIndex).toBe(i);
				expect(chunk.totalChunks).toBe(chunks.length);
			});
		});

		it("should include subject as separate chunk", () => {
			const input = {
				emailId: "test-email-123",
				contentHash: "abc123",
				textNormalized: "Email body content here.",
				subject: "Important Subject Line",
			};

			const chunks = service.chunkEmail(input);

			const subjectChunk = chunks.find((c) => c.sourceType === "subject");
			expect(subjectChunk).toBeDefined();
			expect(subjectChunk?.sectionType).toBe("header");
			expect(subjectChunk?.chunkText).toBe("Important Subject Line");
		});

		it("should handle attachments", () => {
			const input = {
				emailId: "test-email-123",
				contentHash: "abc123",
				textNormalized: "Email body.",
				attachments: [
					{
						attachmentId: "att-123",
						extractedText: "Attachment text content here.",
					},
				],
			};

			const chunks = service.chunkEmail(input);

			const attachmentChunk = chunks.find((c) => c.sourceType === "attachment");
			expect(attachmentChunk).toBeDefined();
			expect(attachmentChunk?.attachmentId).toBe("att-123");
			expect(attachmentChunk?.sectionType).toBe("attachment_text");
		});

		it("should skip quoted content by default", () => {
			const input = {
				emailId: "test-email-123",
				contentHash: "abc123",
				textNormalized: `Thanks for your email.

On Mon, Jan 1, 2024, John wrote:
> This is the original message
> that was quoted.

Best regards`,
			};

			const chunks = service.chunkEmail(input);

			// Should not include the quoted content
			const allText = chunks.map((c) => c.chunkText).join(" ");
			expect(allText).not.toContain("This is the original message");
		});

		it("should handle empty input gracefully", () => {
			const input = {
				emailId: "test-email-123",
				contentHash: "abc123",
				textNormalized: "",
			};

			const chunks = service.chunkEmail(input);

			expect(chunks.length).toBe(0);
		});
	});

	describe("chunk metadata", () => {
		it("should set correct char and token counts", () => {
			const input = {
				emailId: "test-email-123",
				contentHash: "abc123",
				textNormalized: "This is exactly forty characters long!!",
			};

			const chunks = service.chunkEmail(input);

			expect(chunks[0]?.charCount).toBe(40);
			expect(chunks[0]?.tokenCountEstimate).toBe(10); // 40 chars / 4 chars per token
		});

		it("should include versioning info", () => {
			const input = {
				emailId: "test-email-123",
				contentHash: "abc123",
				textNormalized: "Test content.",
			};

			const chunks = service.chunkEmail(input);

			expect(chunks[0]?.chunkingVersion).toBe("v1");
			expect(chunks[0]?.normalizationVersion).toBe("v1");
		});
	});
});

describe("TokenizerService", () => {
	let tokenizer: TokenizerService;

	beforeEach(() => {
		tokenizer = new TokenizerService();
	});

	it("should estimate tokens based on character count", () => {
		expect(tokenizer.estimateTokens("1234")).toBe(1); // 4 chars = 1 token
		expect(tokenizer.estimateTokens("12345678")).toBe(2); // 8 chars = 2 tokens
		expect(tokenizer.estimateTokens("")).toBe(0);
	});

	it("should split at word boundaries", () => {
		const text = "Hello world this is a test of splitting.";
		const result = tokenizer.splitAtTokenBoundary(text, 3); // ~12 chars

		expect(result.chunk).not.toContain("  "); // No double spaces
		expect(result.remaining.length).toBeGreaterThan(0);
	});

	it("should prefer paragraph boundaries", () => {
		const text = "First paragraph.\n\nSecond paragraph with more content.";
		const result = tokenizer.splitAtTokenBoundary(text, 5); // ~20 chars

		expect(result.chunk).toBe("First paragraph.");
		expect(result.remaining).toBe("Second paragraph with more content.");
	});
});

describe("SectionClassifierService", () => {
	let classifier: SectionClassifierService;

	beforeEach(() => {
		classifier = new SectionClassifierService();
	});

	it("should classify quoted content", () => {
		expect(classifier.isQuotedContent("> This is quoted")).toBe(true);
		expect(classifier.isQuotedContent("On Jan 1, 2024, John wrote:")).toBe(
			true,
		);
		expect(classifier.isQuotedContent("Normal text")).toBe(false);
	});

	it("should classify signatures", () => {
		expect(classifier.isSignature("--\nJohn Doe\nCEO")).toBe(true);
		expect(classifier.isSignature("Best regards,\nJohn")).toBe(true);
		expect(classifier.isSignature("Sent from my iPhone")).toBe(true);
		expect(classifier.isSignature("This is normal body text")).toBe(false);
	});

	it("should classify greetings", () => {
		expect(classifier.isGreeting("Hi John,\nHow are you?")).toBe(true);
		expect(classifier.isGreeting("Hello team,\nPlease review")).toBe(true);
		expect(classifier.isGreeting("The meeting is scheduled")).toBe(false);
	});
});
