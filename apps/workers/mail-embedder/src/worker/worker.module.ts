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
import { DB_POOL } from "../db/database.module.js";
import {
	EMBEDDING_REPOSITORY,
	EmbeddingRepository,
} from "../db/embedding.repository.js";
import { EMBEDDING_CONFIG } from "../embedding/embedding.config.js";
import type { EmbeddingConfig } from "../embedding/embedding.config.js";
import { EmbeddingModule } from "../embedding/embedding.module.js";
import { EMBEDDING_SERVICE } from "../embedding/embedding.service.js";
import type { EmbeddingService } from "../embedding/embedding.service.js";
import { MailEmbedderService } from "./worker.service.js";

@Module({
	imports: [EmbeddingModule],
	providers: [
		{
			provide: EMBEDDING_REPOSITORY,
			useFactory: (pool: pg.Pool, logger: LoggerService) =>
				new EmbeddingRepository(pool, logger),
			inject: [DB_POOL, LOGGER],
		},
		{
			provide: MailEmbedderService,
			useFactory: (
				kafka: KafkaService,
				telemetry: TelemetryService,
				logger: LoggerService,
				config: WorkerConfig,
				embeddingRepo: EmbeddingRepository,
				embeddingService: EmbeddingService,
				embeddingConfig: EmbeddingConfig,
			) => {
				return new MailEmbedderService(
					kafka,
					telemetry,
					logger,
					config,
					embeddingRepo,
					embeddingService,
					embeddingConfig,
				);
			},
			inject: [
				KafkaService,
				TelemetryService,
				LOGGER,
				WORKER_CONFIG,
				EMBEDDING_REPOSITORY,
				EMBEDDING_SERVICE,
				EMBEDDING_CONFIG,
			],
		},
	],
	exports: [MailEmbedderService],
})
export class WorkerModule {}
