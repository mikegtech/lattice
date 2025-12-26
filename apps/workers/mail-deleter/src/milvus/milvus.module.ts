import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import {
	MILVUS_CONFIG,
	type MilvusConfig,
	createMilvusConfig,
} from "./milvus.config.js";
import { MILVUS_SERVICE, MilvusService } from "./milvus.service.js";

@Module({
	providers: [
		{
			provide: MILVUS_CONFIG,
			useFactory: (): MilvusConfig => createMilvusConfig(),
		},
		{
			provide: MILVUS_SERVICE,
			useFactory: (config: MilvusConfig, logger: LoggerService) =>
				new MilvusService(config, logger),
			inject: [MILVUS_CONFIG, LOGGER],
		},
	],
	exports: [MILVUS_CONFIG, MILVUS_SERVICE],
})
export class MilvusModule {}
