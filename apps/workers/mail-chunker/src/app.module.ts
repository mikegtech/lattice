import {
	HealthModule,
	KafkaModule,
	LifecycleModule,
	TelemetryModule,
	WorkerConfigModule,
} from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import { DatabaseModule } from "./db/database.module.js";
import { WorkerModule } from "./worker/worker.module.js";

@Module({
	imports: [
		// Core infrastructure modules from worker-base
		WorkerConfigModule,
		TelemetryModule,
		LifecycleModule,
		KafkaModule,
		HealthModule,

		// Worker-specific modules
		DatabaseModule,
		WorkerModule,
	],
})
export class AppModule {}
