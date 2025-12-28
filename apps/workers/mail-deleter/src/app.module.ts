import {
	HealthModule,
	KafkaModule,
	LifecycleModule,
	TelemetryModule,
	WorkerConfigModule,
} from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import { DatabaseModule } from "./db/database.module.js";
import { MilvusModule } from "./milvus/milvus.module.js";
import { StorageModule } from "./storage/storage.module.js";
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
		DatabaseModule.forRoot(),
		MilvusModule,
		StorageModule,
		WorkerModule,
	],
})
export class AppModule {}
