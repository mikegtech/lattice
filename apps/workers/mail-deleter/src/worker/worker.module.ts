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
	DELETION_REPOSITORY,
	DeletionRepository,
} from "../db/deletion.repository.js";
import { MilvusModule } from "../milvus/milvus.module.js";
import {
	MILVUS_SERVICE,
	type MilvusService,
} from "../milvus/milvus.service.js";
import { MailDeleterService } from "./worker.service.js";

@Module({
	imports: [MilvusModule],
	providers: [
		{
			provide: DELETION_REPOSITORY,
			useFactory: (pool: pg.Pool, logger: LoggerService) =>
				new DeletionRepository(pool, logger),
			inject: [DB_POOL, LOGGER],
		},
		{
			provide: MailDeleterService,
			useFactory: (
				kafka: KafkaService,
				telemetry: TelemetryService,
				logger: LoggerService,
				config: WorkerConfig,
				deletionRepo: DeletionRepository,
				milvusService: MilvusService,
			) => {
				return new MailDeleterService(
					kafka,
					telemetry,
					logger,
					config,
					deletionRepo,
					milvusService,
				);
			},
			inject: [
				KafkaService,
				TelemetryService,
				LOGGER,
				WORKER_CONFIG,
				DELETION_REPOSITORY,
				MILVUS_SERVICE,
			],
		},
	],
	exports: [MailDeleterService],
})
export class WorkerModule {}
