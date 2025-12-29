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
import {
	ATTACHMENT_REPOSITORY,
	AttachmentRepository,
} from "../db/attachment.repository.js";
import { DB_POOL, DatabaseModule } from "../db/database.module.js";
import { ExtractionModule } from "../extraction/extraction.module.js";
import {
	EXTRACTION_SERVICE,
	type ExtractionService,
} from "../extraction/extraction.service.js";
import { StorageModule } from "../storage/storage.module.js";
import {
	STORAGE_SERVICE,
	type StorageService,
} from "../storage/storage.service.js";
import { MailExtractorService } from "./worker.service.js";

@Module({
	imports: [DatabaseModule, ExtractionModule, StorageModule],
	providers: [
		{
			provide: ATTACHMENT_REPOSITORY,
			useFactory: (pool: pg.Pool, logger: LoggerService) =>
				new AttachmentRepository(pool, logger),
			inject: [DB_POOL, LOGGER],
		},
		{
			provide: MailExtractorService,
			useFactory: (
				kafka: KafkaService,
				telemetry: TelemetryService,
				logger: LoggerService,
				config: WorkerConfig,
				attachmentRepo: AttachmentRepository,
				extractionService: ExtractionService,
				storageService: StorageService,
			) => {
				return new MailExtractorService(
					kafka,
					telemetry,
					logger,
					config,
					attachmentRepo,
					extractionService,
					storageService,
				);
			},
			inject: [
				KafkaService,
				TelemetryService,
				LOGGER,
				WORKER_CONFIG,
				ATTACHMENT_REPOSITORY,
				EXTRACTION_SERVICE,
				STORAGE_SERVICE,
			],
		},
	],
	exports: [MailExtractorService],
})
export class WorkerModule {}
