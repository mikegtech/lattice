import {
	HealthModule,
	KafkaModule,
	LifecycleModule,
	TelemetryModule,
	WorkerConfigModule,
} from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import { WorkerModule } from "./worker/worker.module.js";

@Module({
	imports: [
		// Core infrastructure modules from worker-base
		WorkerConfigModule.forRoot({
			envFilePath: ".env",
		}),
		TelemetryModule,
		LifecycleModule,
		KafkaModule.forRoot({
			expectedSchemaVersion: "v1",
		}),
		HealthModule,

		// Worker-specific modules
		WorkerModule,
	],
})
export class AppModule {}
