import {
	KafkaService,
	LOGGER,
	type LoggerService,
	TelemetryService,
	WORKER_CONFIG,
	type WorkerConfig,
} from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import type pg from "pg";
import { DB_POOL, DatabaseModule } from "../db/database.module.js";
import { OCR_REPOSITORY, OcrRepository } from "../db/ocr.repository.js";
import { OcrModule } from "../ocr/ocr.module.js";
import {
	TESSERACT_ENGINE,
	type TesseractEngine,
} from "../ocr/tesseract.engine.js";
import { StorageModule } from "../storage/storage.module.js";
import {
	STORAGE_SERVICE,
	type StorageService,
} from "../storage/storage.service.js";
import { OcrWorkerService } from "./worker.service.js";

@Module({
	imports: [DatabaseModule, OcrModule, StorageModule],
	providers: [
		{
			provide: OCR_REPOSITORY,
			useFactory: (pool: pg.Pool, logger: LoggerService) =>
				new OcrRepository(pool, logger),
			inject: [DB_POOL, LOGGER],
		},
		{
			provide: OcrWorkerService,
			useFactory: (
				kafka: KafkaService,
				telemetry: TelemetryService,
				logger: LoggerService,
				config: WorkerConfig,
				ocrRepo: OcrRepository,
				tesseractEngine: TesseractEngine,
				storageService: StorageService,
			) => {
				return new OcrWorkerService(
					kafka,
					telemetry,
					logger,
					config,
					ocrRepo,
					tesseractEngine,
					storageService,
				);
			},
			inject: [
				KafkaService,
				TelemetryService,
				LOGGER,
				WORKER_CONFIG,
				OCR_REPOSITORY,
				TESSERACT_ENGINE,
				STORAGE_SERVICE,
			],
		},
	],
	exports: [OcrWorkerService],
})
export class WorkerModule {}
