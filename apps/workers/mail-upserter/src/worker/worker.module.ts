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
	UPSERT_REPOSITORY,
	UpsertRepository,
} from "../db/upsert.repository.js";
import { MILVUS_CONFIG, type MilvusConfig } from "../milvus/milvus.config.js";
import { MilvusModule } from "../milvus/milvus.module.js";
import {
	MILVUS_SERVICE,
	type MilvusService,
} from "../milvus/milvus.service.js";
import { MailUpserterService } from "./worker.service.js";

@Module({
	imports: [MilvusModule],
	providers: [
		{
			provide: UPSERT_REPOSITORY,
			useFactory: (pool: pg.Pool, logger: LoggerService) =>
				new UpsertRepository(pool, logger),
			inject: [DB_POOL, LOGGER],
		},
		{
			provide: MailUpserterService,
			useFactory: (
				kafka: KafkaService,
				telemetry: TelemetryService,
				logger: LoggerService,
				config: WorkerConfig,
				upsertRepo: UpsertRepository,
				milvusService: MilvusService,
				milvusConfig: MilvusConfig,
			) => {
				return new MailUpserterService(
					kafka,
					telemetry,
					logger,
					config,
					upsertRepo,
					milvusService,
					milvusConfig,
				);
			},
			inject: [
				KafkaService,
				TelemetryService,
				LOGGER,
				WORKER_CONFIG,
				UPSERT_REPOSITORY,
				MILVUS_SERVICE,
				MILVUS_CONFIG,
			],
		},
	],
	exports: [MailUpserterService],
})
export class WorkerModule {}
