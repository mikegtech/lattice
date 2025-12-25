import { Global, Module } from "@nestjs/common";
import { WORKER_CONFIG, type WorkerConfig } from "../config/config.module.js";
import { LOGGER, LoggerService } from "./logger.service.js";
import { TelemetryService } from "./telemetry.service.js";

@Global()
@Module({
	providers: [
		{
			provide: TelemetryService,
			useFactory: (config: WorkerConfig) => {
				const service = new TelemetryService();
				service.initialize(config);
				return service;
			},
			inject: [WORKER_CONFIG],
		},
		{
			provide: LOGGER,
			useFactory: (config: WorkerConfig) => {
				return new LoggerService(config);
			},
			inject: [WORKER_CONFIG],
		},
	],
	exports: [TelemetryService, LOGGER],
})
export class TelemetryModule {}
