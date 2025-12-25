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
import { ParserService } from "./parser.service.js";
import { MailParserService } from "./worker.service.js";

@Module({
	providers: [
		EmailRepository,
		ParserService,
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
