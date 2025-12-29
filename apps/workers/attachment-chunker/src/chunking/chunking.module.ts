import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import {
	CHUNKING_CONFIG,
	type ChunkingConfig,
	ChunkingConfigProvider,
} from "./chunking.config.js";
import { CHUNKING_SERVICE, ChunkingService } from "./chunking.service.js";

@Module({
	providers: [
		ChunkingConfigProvider,
		{
			provide: CHUNKING_SERVICE,
			useFactory: (config: ChunkingConfig, logger: LoggerService) =>
				new ChunkingService(config, logger),
			inject: [CHUNKING_CONFIG, LOGGER],
		},
	],
	exports: [CHUNKING_CONFIG, CHUNKING_SERVICE],
})
export class ChunkingModule {}
