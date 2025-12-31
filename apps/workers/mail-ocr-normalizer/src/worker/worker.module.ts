import {
	KafkaService,
	LOGGER,
	type LoggerService,
	TelemetryService,
	WORKER_CONFIG,
	type WorkerConfig,
} from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module.js";
import {
	STORAGE_SERVICE,
	type StorageService,
} from "../storage/storage.service.js";
import { MailOcrNormalizerService } from "./worker.service.js";

@Module({
	imports: [StorageModule],
	providers: [
		{
			provide: MailOcrNormalizerService,
			useFactory: (
				kafka: KafkaService,
				telemetry: TelemetryService,
				logger: LoggerService,
				config: WorkerConfig,
				storageService: StorageService,
			) => {
				return new MailOcrNormalizerService(
					kafka,
					telemetry,
					logger,
					config,
					storageService,
				);
			},
			inject: [
				KafkaService,
				TelemetryService,
				LOGGER,
				WORKER_CONFIG,
				STORAGE_SERVICE,
			],
		},
	],
	exports: [MailOcrNormalizerService],
})
export class WorkerModule {}
