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
import { CHUNK_REPOSITORY, ChunkRepository } from "../db/chunk.repository.js";
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
			provide: CHUNK_REPOSITORY,
			useFactory: (pool: pg.Pool, logger: LoggerService) =>
				new ChunkRepository(pool, logger),
			inject: [DB_POOL, LOGGER],
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
				chunkRepo: ChunkRepository,
			) => {
				return new AttachmentChunkerService(
					kafka,
					telemetry,
					logger,
					config,
					attachmentRepo,
					chunkingService,
					chunkRepo,
				);
			},
			inject: [
				KafkaService,
				TelemetryService,
				LOGGER,
				WORKER_CONFIG,
				ATTACHMENT_REPOSITORY,
				CHUNKING_SERVICE,
				CHUNK_REPOSITORY,
			],
		},
	],
	exports: [AttachmentChunkerService],
})
export class WorkerModule {}
