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
import { ChunkingModule } from "../chunking/chunking.module.js";
import { CHUNKING_SERVICE } from "../chunking/chunking.service.js";
import type { ChunkingService } from "../chunking/chunking.service.js";
import {
	ATTACHMENT_REPOSITORY,
	AttachmentRepository,
} from "../db/attachment.repository.js";
import { DB_POOL } from "../db/database.module.js";
import { AttachmentChunkerService } from "./worker.service.js";

@Module({
	imports: [ChunkingModule],
	providers: [
		{
			provide: ATTACHMENT_REPOSITORY,
			useFactory: (pool: pg.Pool) => new AttachmentRepository(pool),
			inject: [DB_POOL],
		},
		{
			provide: AttachmentChunkerService,
			useFactory: (
				kafka: KafkaService,
				telemetry: TelemetryService,
				logger: LoggerService,
				config: WorkerConfig,
				attachmentRepo: AttachmentRepository,
				chunkingService: ChunkingService,
			) => {
				return new AttachmentChunkerService(
					kafka,
					telemetry,
					logger,
					config,
					attachmentRepo,
					chunkingService,
				);
			},
			inject: [
				KafkaService,
				TelemetryService,
				LOGGER,
				WORKER_CONFIG,
				ATTACHMENT_REPOSITORY,
				CHUNKING_SERVICE,
			],
		},
	],
	exports: [AttachmentChunkerService],
})
export class WorkerModule {}
