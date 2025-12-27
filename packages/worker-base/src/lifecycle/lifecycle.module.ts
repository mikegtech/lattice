import { Global, Module } from "@nestjs/common";
import { EVENT_LOGGER, type EventLogger } from "../telemetry/events.js";
import { LOGGER, type LoggerService } from "../telemetry/logger.service.js";
import { TelemetryService } from "../telemetry/telemetry.service.js";
import { LifecycleService } from "./lifecycle.service.js";

@Global()
@Module({
	providers: [
		{
			provide: LifecycleService,
			useFactory: (
				logger: LoggerService,
				telemetry: TelemetryService,
				eventLogger: EventLogger,
			) => {
				return new LifecycleService(logger, telemetry, eventLogger);
			},
			inject: [LOGGER, TelemetryService, EVENT_LOGGER],
		},
	],
	exports: [LifecycleService],
})
export class LifecycleModule {}
