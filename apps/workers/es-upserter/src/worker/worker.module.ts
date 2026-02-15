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
import {
	ELASTICSEARCH_CONFIG,
	type ElasticsearchConfig,
} from "../elasticsearch/elasticsearch.config.js";
import { ElasticsearchModule } from "../elasticsearch/elasticsearch.module.js";
import {
	ELASTICSEARCH_SERVICE,
	type ElasticsearchService,
} from "../elasticsearch/elasticsearch.service.js";
import { EsUpserterService } from "./worker.service.js";

@Module({
	imports: [ElasticsearchModule],
	providers: [
		{
			provide: UPSERT_REPOSITORY,
			useFactory: (pool: pg.Pool, logger: LoggerService) =>
				new UpsertRepository(pool, logger),
			inject: [DB_POOL, LOGGER],
		},
		{
			provide: EsUpserterService,
			useFactory: (
				kafka: KafkaService,
				telemetry: TelemetryService,
				logger: LoggerService,
				config: WorkerConfig,
				upsertRepo: UpsertRepository,
				esService: ElasticsearchService,
				esConfig: ElasticsearchConfig,
			) => {
				return new EsUpserterService(
					kafka,
					telemetry,
					logger,
					config,
					upsertRepo,
					esService,
					esConfig,
				);
			},
			inject: [
				KafkaService,
				TelemetryService,
				LOGGER,
				WORKER_CONFIG,
				UPSERT_REPOSITORY,
				ELASTICSEARCH_SERVICE,
				ELASTICSEARCH_CONFIG,
			],
		},
	],
	exports: [EsUpserterService],
})
export class WorkerModule {}
