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
	CHUNKING_CONFIG,
	type ChunkingConfig,
} from "../chunking/chunking.config.js";
import {
	CHUNKING_SERVICE,
	ChunkingModule,
} from "../chunking/chunking.module.js";
import type { ChunkingService } from "../chunking/chunking.service.js";
import { CHUNK_REPOSITORY, ChunkRepository } from "../db/chunk.repository.js";
import { DB_POOL } from "../db/database.module.js";
import { MailChunkerService } from "./worker.service.js";

@Module({
	imports: [ChunkingModule],
	providers: [
		{
			provide: CHUNK_REPOSITORY,
			useFactory: (pool: pg.Pool, logger: LoggerService) =>
				new ChunkRepository(pool, logger),
			inject: [DB_POOL, LOGGER],
		},
		{
			provide: MailChunkerService,
			useFactory: (
				kafka: KafkaService,
				telemetry: TelemetryService,
				logger: LoggerService,
				config: WorkerConfig,
				chunkRepo: ChunkRepository,
				chunkingService: ChunkingService,
				chunkingConfig: ChunkingConfig,
			) => {
				return new MailChunkerService(
					kafka,
					telemetry,
					logger,
					config,
					chunkRepo,
					chunkingService,
					chunkingConfig,
				);
			},
			inject: [
				KafkaService,
				TelemetryService,
				LOGGER,
				WORKER_CONFIG,
				CHUNK_REPOSITORY,
				CHUNKING_SERVICE,
				CHUNKING_CONFIG,
			],
		},
	],
	exports: [MailChunkerService],
})
export class WorkerModule {}
