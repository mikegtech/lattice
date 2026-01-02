import {
	KafkaService,
	LOGGER,
	type LoggerService,
	TelemetryService,
	WORKER_CONFIG,
	type WorkerConfig,
} from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import {
	ATTACHMENT_REPOSITORY,
	AttachmentRepository,
} from "../db/attachment.repository.js";
import { StorageModule } from "../storage/storage.module.js";
import {
	STORAGE_SERVICE,
	type StorageService,
} from "../storage/storage.service.js";
import { MailOcrNormalizerService } from "./worker.service.js";

@Module({
	imports: [StorageModule],
	providers: [
		AttachmentRepository,
		{
			provide: ATTACHMENT_REPOSITORY,
			useExisting: AttachmentRepository,
		},
		{
			provide: MailOcrNormalizerService,
			useFactory: (
				kafka: KafkaService,
				telemetry: TelemetryService,
				logger: LoggerService,
				config: WorkerConfig,
				storageService: StorageService,
				attachmentRepository: AttachmentRepository,
			) => {
				return new MailOcrNormalizerService(
					kafka,
					telemetry,
					logger,
					config,
					storageService,
					attachmentRepository,
				);
			},
			inject: [
				KafkaService,
				TelemetryService,
				LOGGER,
				WORKER_CONFIG,
				STORAGE_SERVICE,
				AttachmentRepository,
			],
		},
	],
	exports: [MailOcrNormalizerService],
})
export class WorkerModule {}
