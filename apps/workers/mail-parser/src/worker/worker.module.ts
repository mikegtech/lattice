import {
	KafkaService,
	LOGGER,
	type LoggerService,
	TelemetryService,
	WORKER_CONFIG,
	type WorkerConfig,
} from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import { EmailRepository } from "../db/email.repository.js";
import { StorageModule } from "../storage/storage.module.js";
import {
	STORAGE_SERVICE,
	type StorageService,
} from "../storage/storage.service.js";
import { ParserService } from "./parser.service.js";
import { MailParserService } from "./worker.service.js";

@Module({
	imports: [StorageModule],
	providers: [
		EmailRepository,
		{
			provide: ParserService,
			useFactory: (storage: StorageService, logger: LoggerService) =>
				new ParserService(storage, logger),
			inject: [STORAGE_SERVICE, LOGGER],
		},
		{
			provide: MailParserService,
			useFactory: (
				kafka: KafkaService,
				telemetry: TelemetryService,
				logger: LoggerService,
				config: WorkerConfig,
				emailRepo: EmailRepository,
				parser: ParserService,
			) => {
				return new MailParserService(
					kafka,
					telemetry,
					logger,
					config,
					emailRepo,
					parser,
				);
			},
			inject: [
				KafkaService,
				TelemetryService,
				LOGGER,
				WORKER_CONFIG,
				EmailRepository,
				ParserService,
			],
		},
	],
	exports: [MailParserService],
})
export class WorkerModule {}
