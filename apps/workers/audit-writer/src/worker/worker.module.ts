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
import { AUDIT_REPOSITORY, AuditRepository } from "../db/audit.repository.js";
import { DB_POOL } from "../db/database.module.js";
import { AuditWriterService } from "./worker.service.js";

@Module({
	providers: [
		{
			provide: AUDIT_REPOSITORY,
			useFactory: (pool: pg.Pool, logger: LoggerService) =>
				new AuditRepository(pool, logger),
			inject: [DB_POOL, LOGGER],
		},
		{
			provide: AuditWriterService,
			useFactory: (
				kafka: KafkaService,
				telemetry: TelemetryService,
				logger: LoggerService,
				config: WorkerConfig,
				auditRepo: AuditRepository,
			) => {
				return new AuditWriterService(
					kafka,
					telemetry,
					logger,
					config,
					auditRepo,
				);
			},
			inject: [
				KafkaService,
				TelemetryService,
				LOGGER,
				WORKER_CONFIG,
				AUDIT_REPOSITORY,
			],
		},
	],
	exports: [AuditWriterService],
})
export class WorkerModule {}
