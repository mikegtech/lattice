import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import { MILVUS_CONFIG, MilvusConfig } from "./milvus.config.js";
import { MILVUS_SERVICE, MilvusService } from "./milvus.service.js";

@Module({
	providers: [
		{
			provide: MILVUS_CONFIG,
			useFactory: () => new MilvusConfig(),
		},
		{
			provide: MILVUS_SERVICE,
			useFactory: (config: MilvusConfig, logger: LoggerService) =>
				new MilvusService(config, logger),
			inject: [MILVUS_CONFIG, LOGGER],
		},
	],
	exports: [MILVUS_SERVICE, MILVUS_CONFIG],
})
export class MilvusModule {}
