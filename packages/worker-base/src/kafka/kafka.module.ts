import { type DynamicModule, Global, Module } from "@nestjs/common";
import { WORKER_CONFIG, type WorkerConfig } from "../config/config.module.js";
import { LOGGER, type LoggerService } from "../telemetry/logger.service.js";
import { TelemetryService } from "../telemetry/telemetry.service.js";
import { KafkaService } from "./kafka.service.js";

export interface KafkaModuleOptions {
	expectedSchemaVersion?: string;
}

@Global()
@Module({})
export class KafkaModule {
	static forRoot(options: KafkaModuleOptions = {}): DynamicModule {
		return {
			module: KafkaModule,
			providers: [
				{
					provide: "KAFKA_OPTIONS",
					useValue: options,
				},
				{
					provide: KafkaService,
					useFactory: (
						config: WorkerConfig,
						telemetry: TelemetryService,
						logger: LoggerService,
					) => {
						return new KafkaService(config, options, telemetry, logger);
					},
					inject: [WORKER_CONFIG, TelemetryService, LOGGER],
				},
			],
			exports: [KafkaService],
		};
	}
}
