import { type ExecSyncOptions, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";

export const TESSERACT_ENGINE = "TESSERACT_ENGINE";

export interface TesseractConfig {
	tesseractPath: string;
	language: string;
	defaultDpi: number;
}

export interface OcrEngineResult {
	text: string;
	pageCount: number;
	confidence?: number;
}

@Injectable()
export class TesseractEngine {
	private readonly config: TesseractConfig;

	constructor(@Inject(LOGGER) private readonly logger: LoggerService) {
		this.config = {
			tesseractPath: process.env["TESSERACT_PATH"] ?? "tesseract",
			language: process.env["TESSERACT_LANG"] ?? "eng",
			defaultDpi: Number.parseInt(process.env["TESSERACT_DPI"] ?? "300", 10),
		};

		this.validateTesseract();
	}

	private validateTesseract(): void {
		try {
			const version = execSync(`${this.config.tesseractPath} --version`, {
				encoding: "utf-8",
				timeout: 5000,
			});
			this.logger.info("Tesseract available", {
				version: version.split("\n")[0],
				language: this.config.language,
			});
		} catch {
			this.logger.warn(
				"Tesseract not found - OCR operations will fail. Install with: apt-get install tesseract-ocr",
			);
		}
	}

	/**
	 * Process content through OCR
	 * Handles: images, PDFs, and ZIP-disguised PDFs (HOA documents)
	 */
	async process(
		content: Buffer,
		mimeType: string,
		dpi?: number,
	): Promise<OcrEngineResult> {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-"));

		try {
			// Detect actual content type (handles ZIP-disguised PDFs)
			const actualType = this.detectContentType(content, mimeType);
			this.logger.debug("Processing OCR", {
				reported_mime: mimeType,
				detected_type: actualType,
			});

			if (actualType === "pdf") {
				return await this.processPdf(content, tmpDir, dpi);
			}
			return await this.processImage(content, tmpDir, mimeType);
		} finally {
			// Cleanup temp directory
			this.cleanupDir(tmpDir);
		}
	}

	/**
	 * Detect actual content type by examining magic bytes
	 */
	private detectContentType(
		content: Buffer,
		reportedMime: string,
	): "pdf" | "image" {
		// PDF magic bytes: %PDF
		if (
			content.length >= 4 &&
			content[0] === 0x25 &&
			content[1] === 0x50 &&
			content[2] === 0x44 &&
			content[3] === 0x46
		) {
			return "pdf";
		}

		// ZIP magic bytes (50 4B) - check for embedded PDF
		if (
			content.length >= 4 &&
			content[0] === 0x50 &&
			content[1] === 0x4b &&
			content[2] === 0x03 &&
			content[3] === 0x04
		) {
			// This is a ZIP file - check if it contains a PDF
			// For now, try to extract and process as PDF
			const extractedPdf = this.extractPdfFromZip(content);
			if (extractedPdf) {
				return "pdf";
			}
		}

		// Default based on MIME type
		if (reportedMime === "application/pdf") {
			return "pdf";
		}

		return "image";
	}

	/**
	 * Extract PDF from ZIP container (HOA document pattern)
	 */
	private extractPdfFromZip(zipContent: Buffer): Buffer | null {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-extract-"));
		const zipPath = path.join(tmpDir, "archive.zip");

		try {
			fs.writeFileSync(zipPath, zipContent);

			// Use unzip to extract
			execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, {
				timeout: 30000,
				stdio: "pipe",
			});

			// Find PDF files
			const files = fs.readdirSync(tmpDir);
			for (const file of files) {
				if (file.toLowerCase().endsWith(".pdf")) {
					const pdfPath = path.join(tmpDir, file);
					return fs.readFileSync(pdfPath);
				}
			}

			// Check subdirectories
			for (const file of files) {
				const subPath = path.join(tmpDir, file);
				if (fs.statSync(subPath).isDirectory()) {
					const subFiles = fs.readdirSync(subPath);
					for (const subFile of subFiles) {
						if (subFile.toLowerCase().endsWith(".pdf")) {
							return fs.readFileSync(path.join(subPath, subFile));
						}
					}
				}
			}

			return null;
		} catch (error) {
			this.logger.debug("Failed to extract PDF from ZIP", { error });
			return null;
		} finally {
			this.cleanupDir(tmpDir);
		}
	}

	/**
	 * Process PDF through OCR by converting to images first
	 */
	private async processPdf(
		content: Buffer,
		tmpDir: string,
		dpi?: number,
	): Promise<OcrEngineResult> {
		const effectiveDpi = dpi ?? this.config.defaultDpi;
		const pdfPath = path.join(tmpDir, "input.pdf");
		fs.writeFileSync(pdfPath, content);

		// Use pdftoppm (from poppler-utils) to convert PDF pages to images
		const imagePrefix = path.join(tmpDir, "page");

		try {
			execSync(
				`pdftoppm -png -r ${effectiveDpi} "${pdfPath}" "${imagePrefix}"`,
				{
					timeout: 120000, // 2 minutes for large PDFs
					stdio: "pipe",
				},
			);
		} catch (error) {
			this.logger.error("pdftoppm failed", String(error));
			throw new Error(
				`PDF to image conversion failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		// Find all generated page images
		const pageImages = fs
			.readdirSync(tmpDir)
			.filter((f) => f.startsWith("page") && f.endsWith(".png"))
			.sort();

		if (pageImages.length === 0) {
			throw new Error("PDF conversion produced no images");
		}

		this.logger.debug("PDF converted to images", {
			page_count: pageImages.length,
			dpi: effectiveDpi,
		});

		// OCR each page and combine results
		const pageTexts: string[] = [];
		let totalConfidence = 0;

		for (const pageImage of pageImages) {
			const imagePath = path.join(tmpDir, pageImage);
			const result = await this.ocrImage(imagePath, tmpDir);
			pageTexts.push(result.text);
			if (result.confidence !== undefined) {
				totalConfidence += result.confidence;
			}
		}

		const combinedText = pageTexts.join("\n\n--- Page Break ---\n\n").trim();
		const avgConfidence =
			pageImages.length > 0 ? totalConfidence / pageImages.length : undefined;

		return {
			text: combinedText,
			pageCount: pageImages.length,
			confidence: avgConfidence,
		};
	}

	/**
	 * Process a single image through OCR
	 */
	private async processImage(
		content: Buffer,
		tmpDir: string,
		mimeType: string,
	): Promise<OcrEngineResult> {
		const ext = this.getExtension(mimeType);
		const imagePath = path.join(tmpDir, `input${ext}`);
		fs.writeFileSync(imagePath, content);

		const result = await this.ocrImage(imagePath, tmpDir);

		return {
			text: result.text,
			pageCount: 1,
			confidence: result.confidence,
		};
	}

	/**
	 * Run Tesseract on a single image file
	 */
	private async ocrImage(
		imagePath: string,
		tmpDir: string,
	): Promise<{ text: string; confidence?: number }> {
		const outputBase = path.join(tmpDir, "output");
		const execOptions: ExecSyncOptions = {
			timeout: 60000, // 1 minute per page
			stdio: "pipe",
		};

		try {
			// Run tesseract with confidence output
			execSync(
				`${this.config.tesseractPath} "${imagePath}" "${outputBase}" -l ${this.config.language} --oem 3 --psm 3`,
				execOptions,
			);

			const text = fs.readFileSync(`${outputBase}.txt`, "utf-8").trim();

			// Try to get confidence from tsv output
			let confidence: number | undefined;
			try {
				execSync(
					`${this.config.tesseractPath} "${imagePath}" "${outputBase}_conf" -l ${this.config.language} --oem 3 --psm 3 tsv`,
					execOptions,
				);
				const tsvContent = fs.readFileSync(`${outputBase}_conf.tsv`, "utf-8");
				confidence = this.parseConfidence(tsvContent);
			} catch {
				// Confidence extraction is optional
			}

			return { text, confidence };
		} catch (error) {
			const msg =
				error instanceof Error ? error.message : "Tesseract execution failed";
			throw new Error(`OCR failed: ${msg}`);
		}
	}

	/**
	 * Parse average confidence from Tesseract TSV output
	 */
	private parseConfidence(tsvContent: string): number | undefined {
		const lines = tsvContent.split("\n").slice(1); // Skip header
		const confidences: number[] = [];

		for (const line of lines) {
			const parts = line.split("\t");
			// TSV format: level, page_num, block_num, par_num, line_num, word_num, left, top, width, height, conf, text
			if (parts.length >= 11) {
				const conf = Number.parseFloat(parts[10] ?? "0");
				if (!Number.isNaN(conf) && conf >= 0) {
					confidences.push(conf);
				}
			}
		}

		if (confidences.length === 0) return undefined;

		const sum = confidences.reduce((a, b) => a + b, 0);
		return Math.round(sum / confidences.length);
	}

	/**
	 * Get file extension for MIME type
	 */
	private getExtension(mimeType: string): string {
		const extensions: Record<string, string> = {
			"image/png": ".png",
			"image/jpeg": ".jpg",
			"image/jpg": ".jpg",
			"image/tiff": ".tiff",
			"image/tif": ".tif",
			"image/bmp": ".bmp",
			"image/gif": ".gif",
			"image/webp": ".webp",
		};
		return extensions[mimeType] ?? ".png";
	}

	/**
	 * Cleanup temporary directory
	 */
	private cleanupDir(dirPath: string): void {
		try {
			fs.rmSync(dirPath, { recursive: true, force: true });
		} catch {
			this.logger.warn("Failed to cleanup temp directory", { path: dirPath });
		}
	}
}
