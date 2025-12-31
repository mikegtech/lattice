import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import {
	STORAGE_CONFIG,
	type StorageConfig,
	StorageConfigFactory,
} from "./storage.config.js";
import { STORAGE_SERVICE, StorageService } from "./storage.service.js";

@Module({
	providers: [
		StorageConfigFactory,
		{
			provide: STORAGE_CONFIG,
			useFactory: (factory: StorageConfigFactory) => factory.create(),
			inject: [StorageConfigFactory],
		},
		{
			provide: STORAGE_SERVICE,
			useFactory: (config: StorageConfig, logger: LoggerService) =>
				new StorageService(config, logger),
			inject: [STORAGE_CONFIG, LOGGER],
		},
	],
	exports: [STORAGE_SERVICE, STORAGE_CONFIG],
})
export class StorageModule {}
