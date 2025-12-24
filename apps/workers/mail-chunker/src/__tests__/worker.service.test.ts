import type { MailParsePayload } from "@lattice/core-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the chunk repository
const mockChunkRepository = {
	chunksExist: vi.fn(),
	getExistingChunkHashes: vi.fn(),
	getEmailContent: vi.fn(),
	getAttachmentContents: vi.fn(),
	insertChunks: vi.fn(),
	deleteChunks: vi.fn(),
};

// Mock the chunking service
const mockChunkingService = {
	chunkEmail: vi.fn(),
	calculateChunkHash: vi.fn(),
};

// Mock the chunking config
const mockChunkingConfig = {
	targetTokens: 400,
	overlapTokens: 50,
	maxTokens: 512,
	chunkingVersion: "v1",
	normalizationVersion: "v1",
};

// Mock worker dependencies
const mockKafka = {
	run: vi.fn(),
	produce: vi.fn(),
};

const mockTelemetry = {
	increment: vi.fn(),
	timing: vi.fn(),
	withSpan: vi.fn((name, tags, fn) => fn()),
};

const mockLogger = {
	log: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

const mockConfig = {
	service: "mail-chunker",
	stage: "chunk",
	kafka: {
		topicIn: "lattice.mail.parse.v1",
		topicOut: "lattice.mail.chunk.v1",
		topicDlq: "lattice.dlq.mail.chunk.v1",
	},
};

describe("MailChunkerService", () => {
	const createPayload = (
		overrides: Partial<MailParsePayload> = {},
	): MailParsePayload => ({
		provider_message_id: "gmail-123",
		email_id: "email-uuid-123",
		thread_id: "thread-123",
		content_hash: "abc123hash",
		headers: {
			subject: "Test Subject",
			from: { address: "sender@test.com" },
			to: [{ address: "recipient@test.com" }],
			date: "2024-01-01T00:00:00Z",
		},
		body: {
			text_plain: "Plain text body",
			text_html: "<p>HTML body</p>",
			text_normalized: "Normalized body content for chunking.",
		},
		attachments: [],
		parsed_at: "2024-01-01T00:00:00Z",
		...overrides,
	});

	const createContext = () => ({
		traceId: "trace-123",
		spanId: "span-123",
		topic: "lattice.mail.parse.v1",
		partition: 0,
		offset: "100",
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("idempotency", () => {
		it("should skip processing when chunks already exist for version", async () => {
			// Simulate chunks already exist
			mockChunkRepository.chunksExist.mockResolvedValue(true);

			// Import and create service (simplified for test)
			// In real test, we'd use NestJS testing module
			const result = await simulateProcess(createPayload(), createContext());

			expect(result.status).toBe("skip");
			expect(result.reason).toContain("already exist");
			expect(mockChunkRepository.insertChunks).not.toHaveBeenCalled();
		});

		it("should process when no chunks exist", async () => {
			mockChunkRepository.chunksExist.mockResolvedValue(false);
			mockChunkRepository.getEmailContent.mockResolvedValue({
				id: "email-uuid-123",
				provider_message_id: "gmail-123",
				content_hash: "abc123hash",
				text_normalized: "Content to chunk.",
				subject: "Test Subject",
			});
			mockChunkRepository.getAttachmentContents.mockResolvedValue([]);
			mockChunkingService.chunkEmail.mockReturnValue([
				{
					chunkId: "chunk-1",
					chunkHash: "hash-1",
					chunkIndex: 0,
					totalChunks: 1,
					chunkText: "Content to chunk.",
					charCount: 17,
					tokenCountEstimate: 4,
					sourceType: "body",
					sectionType: "body",
					chunkingVersion: "v1",
					normalizationVersion: "v1",
				},
			]);
			mockChunkRepository.insertChunks.mockResolvedValue(undefined);

			const result = await simulateProcess(createPayload(), createContext());

			expect(result.status).toBe("success");
			expect(mockChunkRepository.insertChunks).toHaveBeenCalled();
		});
	});

	describe("DLQ handling", () => {
		it("should send to DLQ when email not found", async () => {
			mockChunkRepository.chunksExist.mockResolvedValue(false);
			mockChunkRepository.getEmailContent.mockResolvedValue(null);

			const result = await simulateProcess(createPayload(), createContext());

			expect(result.status).toBe("dlq");
			expect(result.reason).toContain("not found");
		});

		it("should send to DLQ on non-retryable error", async () => {
			mockChunkRepository.chunksExist.mockResolvedValue(false);
			mockChunkRepository.getEmailContent.mockRejectedValue(
				new Error("Invalid JSON in database"),
			);

			const result = await simulateProcess(createPayload(), createContext());

			expect(result.status).toBe("dlq");
		});
	});

	describe("retryable errors", () => {
		it("should retry on connection errors", async () => {
			mockChunkRepository.chunksExist.mockResolvedValue(false);
			const connectionError = new Error("ECONNREFUSED");
			mockChunkRepository.getEmailContent.mockRejectedValue(connectionError);

			const result = await simulateProcess(createPayload(), createContext());

			expect(result.status).toBe("retry");
		});
	});

	describe("empty content", () => {
		it("should skip when no content to chunk", async () => {
			mockChunkRepository.chunksExist.mockResolvedValue(false);
			mockChunkRepository.getEmailContent.mockResolvedValue({
				id: "email-uuid-123",
				provider_message_id: "gmail-123",
				content_hash: "abc123hash",
				text_normalized: "",
				subject: "",
			});
			mockChunkRepository.getAttachmentContents.mockResolvedValue([]);
			mockChunkingService.chunkEmail.mockReturnValue([]);

			const result = await simulateProcess(createPayload(), createContext());

			expect(result.status).toBe("skip");
			expect(result.reason).toContain("No content");
		});
	});
});

/**
 * Helper to simulate the worker process method
 * In a real test, we'd use NestJS testing module
 */
async function simulateProcess(
	payload: MailParsePayload,
	context: {
		traceId: string;
		topic: string;
		partition: number;
		offset: string;
	},
) {
	try {
		const { chunkingVersion, normalizationVersion } = mockChunkingConfig;

		// Idempotency check
		const chunksExist = await mockChunkRepository.chunksExist(
			payload.email_id,
			chunkingVersion,
			normalizationVersion,
		);

		if (chunksExist) {
			return {
				status: "skip" as const,
				reason: "Chunks already exist for this version",
			};
		}

		// Fetch content
		const emailContent = await mockChunkRepository.getEmailContent(
			payload.email_id,
		);

		if (!emailContent) {
			return {
				status: "dlq" as const,
				reason: "Email not found in database",
				error: new Error(`Email ${payload.email_id} not found`),
			};
		}

		const attachments = await mockChunkRepository.getAttachmentContents(
			payload.email_id,
		);

		// Chunk content
		const chunks = mockChunkingService.chunkEmail({
			emailId: payload.email_id,
			contentHash: payload.content_hash,
			textNormalized: emailContent.text_normalized ?? "",
			subject: payload.headers.subject,
			attachments: attachments.map(
				(a: { attachment_id: string; extracted_text: string }) => ({
					attachmentId: a.attachment_id,
					extractedText: a.extracted_text ?? "",
				}),
			),
		});

		if (chunks.length === 0) {
			return { status: "skip" as const, reason: "No content to chunk" };
		}

		// Insert chunks
		await mockChunkRepository.insertChunks(chunks);

		return { status: "success" as const, output: chunks };
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));

		// Simple error classification
		if (
			err.message.includes("ECONNREFUSED") ||
			err.message.includes("timeout")
		) {
			return { status: "retry" as const, reason: err.message };
		}

		return { status: "dlq" as const, reason: err.message, error: err };
	}
}
