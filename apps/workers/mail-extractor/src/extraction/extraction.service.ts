import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";

export const EXTRACTION_SERVICE = "EXTRACTION_SERVICE";

export interface ExtractionResult {
	text: string;
	status: "success" | "failed" | "unsupported";
	error?: string;
}

// Supported MIME types for extraction
const SUPPORTED_MIME_TYPES = new Set([
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"text/plain",
	"text/csv",
	"text/markdown",
	"text/html",
]);

// Maximum text length to extract (5MB of text)
const MAX_TEXT_LENGTH = 5 * 1024 * 1024;

@Injectable()
export class ExtractionService {
	constructor(@Inject(LOGGER) private readonly logger: LoggerService) {}

	/**
	 * Check if a MIME type is supported for extraction
	 */
	isSupported(mimeType: string): boolean {
		return SUPPORTED_MIME_TYPES.has(mimeType);
	}

	/**
	 * Extract text from attachment content based on MIME type
	 */
	async extract(content: Buffer, mimeType: string): Promise<ExtractionResult> {
		if (!this.isSupported(mimeType)) {
			return {
				text: "",
				status: "unsupported",
				error: `Unsupported MIME type: ${mimeType}`,
			};
		}

		try {
			let text: string;

			switch (mimeType) {
				case "application/pdf":
					text = await this.extractPdf(content);
					break;

				case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
					text = await this.extractDocx(content);
					break;

				case "text/plain":
				case "text/csv":
				case "text/markdown":
					text = this.extractPlainText(content);
					break;

				case "text/html":
					text = this.extractHtml(content);
					break;

				default:
					return {
						text: "",
						status: "unsupported",
						error: `Unsupported MIME type: ${mimeType}`,
					};
			}

			// Truncate if too long
			if (text.length > MAX_TEXT_LENGTH) {
				this.logger.warn("Extracted text truncated", {
					original_length: text.length,
					max_length: MAX_TEXT_LENGTH,
				});
				text = text.substring(0, MAX_TEXT_LENGTH);
			}

			return { text: text.trim(), status: "success" };
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown extraction error";

			this.logger.error("Extraction failed", errorMessage, mimeType);

			return {
				text: "",
				status: "failed",
				error: errorMessage,
			};
		}
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
