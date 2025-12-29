import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import {
	STORAGE_CONFIG,
	type StorageConfig,
	createStorageConfig,
} from "./storage.config.js";
import { STORAGE_SERVICE, StorageService } from "./storage.service.js";

@Module({
	providers: [
		{
			provide: STORAGE_CONFIG,
			useFactory: createStorageConfig,
		},
		{
			provide: STORAGE_SERVICE,
			useFactory: (config: StorageConfig, logger: LoggerService) =>
				new StorageService(config, logger),
			inject: [STORAGE_CONFIG, LOGGER],
		},
	],
	exports: [STORAGE_SERVICE],
})
export class StorageModule {}
