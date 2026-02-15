import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Global, Module } from "@nestjs/common";
import {
	ELASTICSEARCH_CONFIG,
	loadElasticsearchConfig,
} from "./elasticsearch.config.js";
import {
	ELASTICSEARCH_SERVICE,
	ElasticsearchService,
} from "./elasticsearch.service.js";

@Global()
@Module({
	providers: [
		{
			provide: ELASTICSEARCH_CONFIG,
			useFactory: () => loadElasticsearchConfig(),
		},
		{
			provide: ELASTICSEARCH_SERVICE,
			useFactory: (
				config: ReturnType<typeof loadElasticsearchConfig>,
				logger: LoggerService,
			) => new ElasticsearchService(config, logger),
			inject: [ELASTICSEARCH_CONFIG, LOGGER],
		},
	],
	exports: [ELASTICSEARCH_SERVICE, ELASTICSEARCH_CONFIG],
})
export class ElasticsearchModule {}
