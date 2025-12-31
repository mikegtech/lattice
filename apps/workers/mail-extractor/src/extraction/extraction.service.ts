import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";

export const EXTRACTION_SERVICE = "EXTRACTION_SERVICE";

/**
 * Reasons why OCR processing is needed for an attachment
 */
export type OcrReason =
	| "image_attachment"
	| "pdf_no_text"
	| "pdf_low_quality_text"
	| "unsupported_format";

/**
 * Text quality metrics for extraction analysis
 */
export interface TextQualityMetrics {
	/** Length of extracted text after trimming */
	length: number;
	/** Ratio of printable ASCII characters (0-1) */
	printable_ratio: number;
	/** Ratio of letter characters (0-1) */
	letter_ratio: number;
	/** Whether quality meets minimum thresholds */
	meets_threshold: boolean;
}

/**
 * Result of text extraction from an attachment
 *
 * Status meanings:
 * - "success": Text was successfully extracted with acceptable quality
 * - "needs_ocr": Extraction completed but OCR is required (image-based PDF, image file, low quality text)
 * - "unsupported": MIME type is not supported for any extraction
 * - "failed": Actual error occurred during extraction (parser crash, invalid content, etc.)
 *
 * Downstream consumers should check needs_ocr to route attachments for OCR processing.
 */
export interface ExtractionResult {
	/** Extracted text (empty string if extraction failed or needs OCR) */
	text: string;
	/** Extraction status */
	status: "success" | "failed" | "unsupported" | "needs_ocr";
	/** Error message for failed/unsupported status */
	error?: string;
	/** Whether this attachment needs OCR processing */
	needs_ocr: boolean;
	/** Reason why OCR is needed (only set when needs_ocr is true) */
	ocr_reason?: OcrReason;
	/** Text quality metrics (only set for text-based extractions) */
	text_quality?: TextQualityMetrics;
}

// =============================================================================
// MIME Type Configuration
// =============================================================================

/** MIME types that support direct text extraction */
const TEXT_EXTRACTABLE_MIME_TYPES = new Set([
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"text/plain",
	"text/csv",
	"text/markdown",
	"text/html",
]);

/** Image MIME types that require OCR */
const IMAGE_MIME_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/tiff",
	"image/webp",
	"image/heic",
	"image/gif",
	"image/bmp",
]);

/** All supported MIME types (text extractable + images) */
const ALL_SUPPORTED_MIME_TYPES = new Set([
	...TEXT_EXTRACTABLE_MIME_TYPES,
	...IMAGE_MIME_TYPES,
]);

// =============================================================================
// Quality Thresholds
// =============================================================================

/** Maximum text length to extract (5MB of text) */
const MAX_TEXT_LENGTH = 5 * 1024 * 1024;

/** Minimum text length to consider extraction successful */
const MIN_TEXT_LENGTH = 10;

/** Minimum ratio of printable characters for acceptable quality */
const MIN_PRINTABLE_RATIO = 0.8;

/** Minimum ratio of letter characters for acceptable quality */
const MIN_LETTER_RATIO = 0.3;

@Injectable()
export class ExtractionService {
	constructor(@Inject(LOGGER) private readonly logger: LoggerService) {}

	/**
	 * Check if a MIME type is supported for extraction (including OCR-routed types)
	 */
	isSupported(mimeType: string): boolean {
		return ALL_SUPPORTED_MIME_TYPES.has(mimeType);
	}

	/**
	 * Check if a MIME type is an image that requires OCR
	 */
	isImageType(mimeType: string): boolean {
		return IMAGE_MIME_TYPES.has(mimeType);
	}

	/**
	 * Check if a MIME type supports direct text extraction
	 */
	isTextExtractable(mimeType: string): boolean {
		return TEXT_EXTRACTABLE_MIME_TYPES.has(mimeType);
	}

	/**
	 * Extract text from attachment content based on MIME type.
	 *
	 * For text-extractable types (PDF, DOCX, etc.), attempts extraction and
	 * analyzes quality to determine if OCR fallback is needed.
	 *
	 * For image types, immediately returns needs_ocr=true without attempting extraction.
	 */
	async extract(content: Buffer, mimeType: string): Promise<ExtractionResult> {
		// Handle unsupported MIME types
		if (!this.isSupported(mimeType)) {
			this.logger.info("Unsupported MIME type for extraction", {
				mime_type: mimeType,
			});
			return {
				text: "",
				status: "unsupported",
				error: `Unsupported MIME type: ${mimeType}`,
				needs_ocr: false,
			};
		}

		// Handle image types - route directly to OCR
		if (this.isImageType(mimeType)) {
			this.logger.info("Image attachment requires OCR", {
				mime_type: mimeType,
				content_size: content.length,
			});
			return {
				text: "",
				status: "needs_ocr",
				needs_ocr: true,
				ocr_reason: "image_attachment",
			};
		}

		// Attempt text extraction for text-extractable types
		try {
			let rawText: string;

			switch (mimeType) {
				case "application/pdf":
					rawText = await this.extractPdf(content);
					break;

				case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
					rawText = await this.extractDocx(content);
					break;

				case "text/plain":
				case "text/csv":
				case "text/markdown":
					rawText = this.extractPlainText(content);
					break;

				case "text/html":
					rawText = this.extractHtml(content);
					break;

				default:
					// Should not reach here due to isSupported check, but handle defensively
					return {
						text: "",
						status: "unsupported",
						error: `Unhandled MIME type: ${mimeType}`,
						needs_ocr: false,
					};
			}

			// Truncate if too long
			if (rawText.length > MAX_TEXT_LENGTH) {
				this.logger.warn("Extracted text truncated", {
					mime_type: mimeType,
					original_length: rawText.length,
					max_length: MAX_TEXT_LENGTH,
				});
				rawText = rawText.substring(0, MAX_TEXT_LENGTH);
			}

			const trimmedText = rawText.trim();
			const quality = this.computeTextQuality(trimmedText);

			// For PDFs, check if text extraction yielded usable results
			if (mimeType === "application/pdf") {
				return this.evaluatePdfExtraction(trimmedText, quality);
			}

			// For other text formats, if extraction yields nothing, it's likely a real failure
			if (!quality.meets_threshold) {
				this.logger.warn("Text extraction yielded low quality result", {
					mime_type: mimeType,
					text_length: quality.length,
					printable_ratio: quality.printable_ratio,
					letter_ratio: quality.letter_ratio,
				});
				return {
					text: "",
					status: "failed",
					error: `Extraction yielded unusable text (length: ${quality.length}, printable: ${(quality.printable_ratio * 100).toFixed(1)}%)`,
					needs_ocr: false,
					text_quality: quality,
				};
			}

			// Successful extraction
			return {
				text: trimmedText,
				status: "success",
				needs_ocr: false,
				text_quality: quality,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown extraction error";
			const errorStack = error instanceof Error ? error.stack : undefined;

			this.logger.error(
				"Extraction failed with exception",
				errorStack,
				JSON.stringify({
					mime_type: mimeType,
					error: errorMessage,
					content_size: content.length,
				}),
			);

			return {
				text: "",
				status: "failed",
				error: errorMessage,
				needs_ocr: false,
			};
		}
	}

	/**
	 * Compute text quality metrics for extraction analysis
	 */
	private computeTextQuality(text: string): TextQualityMetrics {
		const length = text.length;

		if (length === 0) {
			return {
				length: 0,
				printable_ratio: 0,
				letter_ratio: 0,
				meets_threshold: false,
			};
		}

		// Count printable ASCII characters (space through tilde, plus common whitespace)
		let printableCount = 0;
		let letterCount = 0;

		for (let i = 0; i < length; i++) {
			const code = text.charCodeAt(i);
			// Printable ASCII: space (32) through tilde (126), plus tab (9), newline (10), carriage return (13)
			if (
				(code >= 32 && code <= 126) ||
				code === 9 ||
				code === 10 ||
				code === 13
			) {
				printableCount++;
			}
			// Letters: A-Z (65-90) and a-z (97-122)
			if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
				letterCount++;
			}
		}

		const printable_ratio = printableCount / length;
		const letter_ratio = letterCount / length;

		const meets_threshold =
			length >= MIN_TEXT_LENGTH &&
			printable_ratio >= MIN_PRINTABLE_RATIO &&
			letter_ratio >= MIN_LETTER_RATIO;

		return {
			length,
			printable_ratio,
			letter_ratio,
			meets_threshold,
		};
	}

	/**
	 * Evaluate PDF extraction results and determine if OCR is needed
	 */
	private evaluatePdfExtraction(
		text: string,
		quality: TextQualityMetrics,
	): ExtractionResult {
		// Case 1: No text extracted at all - PDF is likely image-based
		if (quality.length === 0) {
			this.logger.info("PDF extraction yielded no text, OCR required", {
				reason: "pdf_no_text",
			});
			return {
				text: "",
				status: "needs_ocr",
				needs_ocr: true,
				ocr_reason: "pdf_no_text",
				text_quality: quality,
			};
		}

		// Case 2: Very short text - likely just whitespace/artifacts from image PDF
		if (quality.length < MIN_TEXT_LENGTH) {
			this.logger.info("PDF extraction yielded minimal text, OCR required", {
				reason: "pdf_no_text",
				text_length: quality.length,
			});
			return {
				text: "",
				status: "needs_ocr",
				needs_ocr: true,
				ocr_reason: "pdf_no_text",
				text_quality: quality,
			};
		}

		// Case 3: Text extracted but quality is poor (garbage characters, encoding issues)
		if (!quality.meets_threshold) {
			this.logger.info(
				"PDF extraction yielded low quality text, OCR required",
				{
					reason: "pdf_low_quality_text",
					text_length: quality.length,
					printable_ratio: quality.printable_ratio,
					letter_ratio: quality.letter_ratio,
				},
			);
			return {
				text: "",
				status: "needs_ocr",
				needs_ocr: true,
				ocr_reason: "pdf_low_quality_text",
				text_quality: quality,
			};
		}

		// Case 4: Good quality text extracted
		return {
			text,
			status: "success",
			needs_ocr: false,
			text_quality: quality,
		};
	}

	/**
	 * Extract text from PDF using pdf-parse
	 */
	private async extractPdf(content: Buffer): Promise<string> {
		const result = await pdfParse(content);
		return result.text;
	}

	/**
	 * Extract text from DOCX using mammoth
	 */
	private async extractDocx(content: Buffer): Promise<string> {
		const result = await mammoth.extractRawText({ buffer: content });
		return result.value;
	}

	/**
	 * Extract text from plain text files
	 */
	private extractPlainText(content: Buffer): string {
		return content.toString("utf-8");
	}

	/**
	 * Extract text from HTML by stripping tags
	 */
	private extractHtml(content: Buffer): string {
		const html = content.toString("utf-8");
		return html
			.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
			.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/\s+/g, " ")
			.trim();
	}
}
