import {
	KafkaService,
	LOGGER,
	type LoggerService,
	TelemetryService,
	WORKER_CONFIG,
	type WorkerConfig,
} from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import { ChunkingConfig } from "../chunking/chunking.config.js";
import { ChunkingModule } from "../chunking/chunking.module.js";
import { ChunkingService } from "../chunking/chunking.service.js";
import { ChunkRepository } from "../db/chunk.repository.js";
import { MailChunkerService } from "./worker.service.js";

@Module({
	imports: [ChunkingModule],
	providers: [
		ChunkRepository,
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
				ChunkRepository,
				ChunkingService,
				ChunkingConfig,
			],
		},
	],
	exports: [MailChunkerService],
})
export class WorkerModule {}
