import { Global, Module } from "@nestjs/common";
import { LOGGER } from "../telemetry/logger.service.js";
import { TelemetryService } from "../telemetry/telemetry.service.js";
import { LifecycleService } from "./lifecycle.service.js";

@Global()
@Module({
	providers: [
		{
			provide: LifecycleService,
			useFactory: (logger: any, telemetry: TelemetryService) => {
				return new LifecycleService(logger, telemetry);
			},
			inject: [LOGGER, TelemetryService],
		},
	],
	exports: [LifecycleService],
})
export class LifecycleModule {}
