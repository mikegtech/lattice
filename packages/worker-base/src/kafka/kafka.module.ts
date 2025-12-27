import { type DynamicModule, Global, Module, Optional } from "@nestjs/common";
import { WORKER_CONFIG, type WorkerConfig } from "../config/config.module.js";
import { LifecycleService } from "../lifecycle/lifecycle.service.js";
import { EVENT_LOGGER, type EventLogger } from "../telemetry/events.js";
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
						eventLogger: EventLogger,
						lifecycle?: LifecycleService,
					) => {
						return new KafkaService(
							config,
							options,
							telemetry,
							logger,
							eventLogger,
							lifecycle,
						);
					},
					inject: [
						WORKER_CONFIG,
						TelemetryService,
						LOGGER,
						EVENT_LOGGER,
						{ token: LifecycleService, optional: true },
					],
				},
			],
			exports: [KafkaService],
		};
	}
}
