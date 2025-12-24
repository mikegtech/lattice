import { type DynamicModule, Global, Module } from "@nestjs/common";
import { WORKER_CONFIG, type WorkerConfig } from "../config/config.module.js";
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
				KafkaService,
			],
			exports: [KafkaService],
		};
	}
}
