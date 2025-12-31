import type { OcrResultRecord, OcrStatus } from "@lattice/core-contracts";
import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { DB_POOL } from "./database.module.js";

export const OCR_REPOSITORY = "OCR_REPOSITORY";

export interface CreateOcrResultParams {
	requestId: string;
	tenantId: string;
	sourceService: string;
	correlationId: string;
	inputUri: string;
	inputMimeType: string;
	inputSizeBytes?: number;
}

export interface UpdateOcrResultParams {
	status: OcrStatus;
	textUri?: string;
	textLength?: number;
	pageCount?: number;
	processingTimeMs?: number;
	confidence?: number;
	errorCode?: string;
	errorMessage?: string;
}

@Injectable()
export class OcrRepository {
	constructor(
		@Inject(DB_POOL) private readonly pool: pg.Pool,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	/**
	 * Check if OCR result already exists for this request_id (idempotency)
	 */
	async findByRequestId(requestId: string): Promise<OcrResultRecord | null> {
		const client = await this.pool.connect();
		try {
			const result = await client.query<OcrResultRecord>(
				"SELECT * FROM ocr_result WHERE request_id = $1",
				[requestId],
			);

			return result.rows[0] ?? null;
		} finally {
			client.release();
		}
	}

	/**
	 * Create a new OCR result record (marks processing started)
	 */
	async createResult(params: CreateOcrResultParams): Promise<OcrResultRecord> {
		const client = await this.pool.connect();
		try {
			const result = await client.query<OcrResultRecord>(
				`INSERT INTO ocr_result (
					request_id,
					tenant_id,
					source_service,
					correlation_id,
					input_uri,
					input_mime_type,
					input_size_bytes,
					status,
					created_at
				) VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', NOW())
				RETURNING *`,
				[
					params.requestId,
					params.tenantId,
					params.sourceService,
					params.correlationId,
					params.inputUri,
					params.inputMimeType,
					params.inputSizeBytes ?? null,
				],
			);

			this.logger.debug("Created OCR result record", {
				request_id: params.requestId,
				source_service: params.sourceService,
			});

			return result.rows[0]!;
		} finally {
			client.release();
		}
	}

	/**
	 * Update OCR result with processing outcome
	 */
	async updateResult(
		requestId: string,
		params: UpdateOcrResultParams,
	): Promise<OcrResultRecord | null> {
		const client = await this.pool.connect();
		try {
			const result = await client.query<OcrResultRecord>(
				`UPDATE ocr_result SET
					status = $1,
					text_uri = $2,
					text_length = $3,
					page_count = $4,
					processing_time_ms = $5,
					confidence = $6,
					error_code = $7,
					error_message = $8,
					completed_at = NOW()
				WHERE request_id = $9
				RETURNING *`,
				[
					params.status,
					params.textUri ?? null,
					params.textLength ?? null,
					params.pageCount ?? null,
					params.processingTimeMs ?? null,
					params.confidence ?? null,
					params.errorCode ?? null,
					params.errorMessage ?? null,
					requestId,
				],
			);

			if (result.rowCount === 0) {
				this.logger.warn("OCR result not found for update", {
					request_id: requestId,
				});
				return null;
			}

			this.logger.debug("Updated OCR result record", {
				request_id: requestId,
				status: params.status,
			});

			return result.rows[0]!;
		} finally {
			client.release();
		}
	}
}
