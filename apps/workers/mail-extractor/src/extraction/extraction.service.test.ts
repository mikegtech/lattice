import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExtractionService } from "./extraction.service.js";

// Mock pdf-parse
vi.mock("pdf-parse", () => ({
	default: vi.fn(),
}));

// Mock mammoth
vi.mock("mammoth", () => ({
	default: {
		extractRawText: vi.fn(),
	},
}));

import mammoth from "mammoth";
// Import mocked modules
import pdfParse from "pdf-parse";

// Helper to create pdf-parse result with correct types
const createPdfResult = (text: string, numpages = 1) => ({
	text,
	numpages,
	numrender: numpages,
	info: {},
	metadata: null,
	version: "v1.10.100" as const,
});

// Mock logger
const mockLogger = {
	log: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

describe("ExtractionService", () => {
	let service: ExtractionService;

	beforeEach(() => {
		vi.clearAllMocks();
		service = new ExtractionService(mockLogger as any);
	});

	describe("isSupported", () => {
		it("should return true for text-extractable MIME types", () => {
			expect(service.isSupported("application/pdf")).toBe(true);
			expect(
				service.isSupported(
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				),
			).toBe(true);
			expect(service.isSupported("text/plain")).toBe(true);
			expect(service.isSupported("text/csv")).toBe(true);
			expect(service.isSupported("text/markdown")).toBe(true);
			expect(service.isSupported("text/html")).toBe(true);
		});

		it("should return true for image MIME types", () => {
			expect(service.isSupported("image/jpeg")).toBe(true);
			expect(service.isSupported("image/png")).toBe(true);
			expect(service.isSupported("image/tiff")).toBe(true);
			expect(service.isSupported("image/webp")).toBe(true);
			expect(service.isSupported("image/heic")).toBe(true);
			expect(service.isSupported("image/gif")).toBe(true);
			expect(service.isSupported("image/bmp")).toBe(true);
		});

		it("should return false for unsupported MIME types", () => {
			expect(service.isSupported("application/octet-stream")).toBe(false);
			expect(service.isSupported("video/mp4")).toBe(false);
			expect(service.isSupported("audio/mpeg")).toBe(false);
			expect(service.isSupported("application/zip")).toBe(false);
		});
	});

	describe("isImageType", () => {
		it("should return true for image MIME types", () => {
			expect(service.isImageType("image/jpeg")).toBe(true);
			expect(service.isImageType("image/png")).toBe(true);
			expect(service.isImageType("image/tiff")).toBe(true);
		});

		it("should return false for non-image MIME types", () => {
			expect(service.isImageType("application/pdf")).toBe(false);
			expect(service.isImageType("text/plain")).toBe(false);
		});
	});

	describe("isTextExtractable", () => {
		it("should return true for text-extractable MIME types", () => {
			expect(service.isTextExtractable("application/pdf")).toBe(true);
			expect(service.isTextExtractable("text/plain")).toBe(true);
		});

		it("should return false for image MIME types", () => {
			expect(service.isTextExtractable("image/jpeg")).toBe(false);
			expect(service.isTextExtractable("image/png")).toBe(false);
		});
	});

	describe("extract - PDF handling", () => {
		it("should return needs_ocr with reason pdf_no_text for empty PDF text", async () => {
			vi.mocked(pdfParse).mockResolvedValue(createPdfResult("", 4));

			const result = await service.extract(
				Buffer.from("fake pdf content"),
				"application/pdf",
			);

			expect(result.status).toBe("needs_ocr");
			expect(result.needs_ocr).toBe(true);
			expect(result.ocr_reason).toBe("pdf_no_text");
			expect(result.text).toBe("");
			expect(result.text_quality?.length).toBe(0);
		});

		it("should return needs_ocr with reason pdf_no_text for very short PDF text", async () => {
			// Text below MIN_TEXT_LENGTH (10 chars)
			vi.mocked(pdfParse).mockResolvedValue(createPdfResult("abc"));

			const result = await service.extract(
				Buffer.from("fake pdf content"),
				"application/pdf",
			);

			expect(result.status).toBe("needs_ocr");
			expect(result.needs_ocr).toBe(true);
			expect(result.ocr_reason).toBe("pdf_no_text");
			expect(result.text).toBe("");
		});

		it("should return needs_ocr with reason pdf_low_quality_text for garbage text", async () => {
			// Text with low letter ratio (mostly numbers/symbols)
			vi.mocked(pdfParse).mockResolvedValue(
				createPdfResult("12345678901234567890!@#$%^&*()_+"),
			);

			const result = await service.extract(
				Buffer.from("fake pdf content"),
				"application/pdf",
			);

			expect(result.status).toBe("needs_ocr");
			expect(result.needs_ocr).toBe(true);
			expect(result.ocr_reason).toBe("pdf_low_quality_text");
			expect(result.text).toBe("");
			expect(result.text_quality?.letter_ratio).toBeLessThan(0.3);
		});

		it("should return success for PDF with good quality text", async () => {
			const goodText =
				"This is a well-formed PDF document with proper text content that should pass all quality checks.";
			vi.mocked(pdfParse).mockResolvedValue(createPdfResult(goodText));

			const result = await service.extract(
				Buffer.from("fake pdf content"),
				"application/pdf",
			);

			expect(result.status).toBe("success");
			expect(result.needs_ocr).toBe(false);
			expect(result.ocr_reason).toBeUndefined();
			expect(result.text).toBe(goodText);
			expect(result.text_quality?.meets_threshold).toBe(true);
		});

		it("should return failed for PDF parser exceptions", async () => {
			vi.mocked(pdfParse).mockRejectedValue(new Error("PDF parsing failed"));

			const result = await service.extract(
				Buffer.from("invalid pdf"),
				"application/pdf",
			);

			expect(result.status).toBe("failed");
			expect(result.needs_ocr).toBe(false);
			expect(result.error).toBe("PDF parsing failed");
		});
	});

	describe("extract - Image handling", () => {
		it("should return needs_ocr with reason image_attachment for JPEG", async () => {
			const result = await service.extract(
				Buffer.from("fake jpeg content"),
				"image/jpeg",
			);

			expect(result.status).toBe("needs_ocr");
			expect(result.needs_ocr).toBe(true);
			expect(result.ocr_reason).toBe("image_attachment");
			expect(result.text).toBe("");
		});

		it("should return needs_ocr with reason image_attachment for PNG", async () => {
			const result = await service.extract(
				Buffer.from("fake png content"),
				"image/png",
			);

			expect(result.status).toBe("needs_ocr");
			expect(result.needs_ocr).toBe(true);
			expect(result.ocr_reason).toBe("image_attachment");
			expect(result.text).toBe("");
		});

		it("should return needs_ocr with reason image_attachment for TIFF", async () => {
			const result = await service.extract(
				Buffer.from("fake tiff content"),
				"image/tiff",
			);

			expect(result.status).toBe("needs_ocr");
			expect(result.needs_ocr).toBe(true);
			expect(result.ocr_reason).toBe("image_attachment");
			expect(result.text).toBe("");
		});
	});

	describe("extract - Unsupported MIME types", () => {
		it("should return unsupported for unknown MIME type", async () => {
			const result = await service.extract(
				Buffer.from("some data"),
				"application/octet-stream",
			);

			expect(result.status).toBe("unsupported");
			expect(result.needs_ocr).toBe(false);
			expect(result.error).toContain("Unsupported MIME type");
		});

		it("should return unsupported for video MIME type", async () => {
			const result = await service.extract(
				Buffer.from("video data"),
				"video/mp4",
			);

			expect(result.status).toBe("unsupported");
			expect(result.needs_ocr).toBe(false);
		});
	});

	describe("extract - DOCX handling", () => {
		it("should return success for DOCX with good text", async () => {
			const goodText =
				"This is a Word document with proper content that passes quality checks.";
			vi.mocked(mammoth.extractRawText).mockResolvedValue({
				value: goodText,
				messages: [],
			});

			const result = await service.extract(
				Buffer.from("fake docx content"),
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			);

			expect(result.status).toBe("success");
			expect(result.needs_ocr).toBe(false);
			expect(result.text).toBe(goodText);
		});

		it("should return failed for empty DOCX", async () => {
			vi.mocked(mammoth.extractRawText).mockResolvedValue({
				value: "",
				messages: [],
			});

			const result = await service.extract(
				Buffer.from("fake docx content"),
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			);

			expect(result.status).toBe("failed");
			expect(result.needs_ocr).toBe(false);
			expect(result.error).toContain("Extraction yielded unusable text");
		});
	});

	describe("extract - Plain text handling", () => {
		it("should return success for valid plain text", async () => {
			const content = Buffer.from(
				"This is a plain text file with some content.",
			);

			const result = await service.extract(content, "text/plain");

			expect(result.status).toBe("success");
			expect(result.needs_ocr).toBe(false);
			expect(result.text).toBe("This is a plain text file with some content.");
		});

		it("should return success for valid CSV", async () => {
			const content = Buffer.from("name,email,phone\nJohn,john@test.com,123");

			const result = await service.extract(content, "text/csv");

			expect(result.status).toBe("success");
			expect(result.needs_ocr).toBe(false);
		});
	});

	describe("extract - HTML handling", () => {
		it("should strip HTML tags and return text", async () => {
			const html = Buffer.from(
				"<html><body><p>Hello World</p><script>evil()</script></body></html>",
			);

			const result = await service.extract(html, "text/html");

			expect(result.status).toBe("success");
			expect(result.text).not.toContain("<");
			expect(result.text).not.toContain("script");
			expect(result.text).toContain("Hello World");
		});
	});

	describe("text quality metrics", () => {
		it("should compute correct metrics for normal text", async () => {
			const normalText =
				"Hello, this is a normal English sentence with proper characters.";
			vi.mocked(pdfParse).mockResolvedValue(createPdfResult(normalText));

			const result = await service.extract(
				Buffer.from("pdf"),
				"application/pdf",
			);

			expect(result.text_quality).toBeDefined();
			expect(result.text_quality?.length).toBe(normalText.length);
			expect(result.text_quality?.printable_ratio).toBeGreaterThan(0.9);
			expect(result.text_quality?.letter_ratio).toBeGreaterThan(0.5);
			expect(result.text_quality?.meets_threshold).toBe(true);
		});

		it("should detect low quality text with non-printable characters", async () => {
			// Text with many non-printable characters
			const badText = "abc\x00\x01\x02\x03\x04\x05\x06\x07\x08xyz";
			vi.mocked(pdfParse).mockResolvedValue(createPdfResult(badText));

			const result = await service.extract(
				Buffer.from("pdf"),
				"application/pdf",
			);

			expect(result.status).toBe("needs_ocr");
			expect(result.text_quality?.printable_ratio).toBeLessThan(0.8);
		});
	});

	describe("text truncation", () => {
		it("should truncate text exceeding MAX_TEXT_LENGTH", async () => {
			// Create text longer than 5MB
			const longText = "a".repeat(6 * 1024 * 1024);
			vi.mocked(pdfParse).mockResolvedValue(createPdfResult(longText, 1000));

			const result = await service.extract(
				Buffer.from("pdf"),
				"application/pdf",
			);

			expect(result.text.length).toBeLessThanOrEqual(5 * 1024 * 1024);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				"Extracted text truncated",
				expect.objectContaining({
					original_length: longText.length,
					max_length: 5 * 1024 * 1024,
				}),
			);
		});
	});

	describe("logging behavior", () => {
		it("should not log extracted text content", async () => {
			const sensitiveText = "This contains sensitive PII information";
			vi.mocked(pdfParse).mockResolvedValue(createPdfResult(sensitiveText));

			await service.extract(Buffer.from("pdf"), "application/pdf");

			// Check that no log call contains the actual text content
			const allLogCalls = [
				...mockLogger.info.mock.calls,
				...mockLogger.warn.mock.calls,
				...mockLogger.debug.mock.calls,
			];

			for (const call of allLogCalls) {
				const logMessage = JSON.stringify(call);
				expect(logMessage).not.toContain(sensitiveText);
			}
		});

		it("should log metadata only for OCR-needed cases", async () => {
			vi.mocked(pdfParse).mockResolvedValue(createPdfResult("", 4));

			await service.extract(Buffer.from("pdf"), "application/pdf");

			expect(mockLogger.info).toHaveBeenCalledWith(
				"PDF extraction yielded no text, OCR required",
				expect.objectContaining({
					reason: "pdf_no_text",
				}),
			);
		});
	});
});
