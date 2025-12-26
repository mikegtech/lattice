import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import { EMBEDDING_CONFIG, EmbeddingConfig } from "./embedding.config.js";
import { EMBEDDING_SERVICE, EmbeddingService } from "./embedding.service.js";
import { EMBEDDING_PROVIDER } from "./providers/embedding-provider.interface.js";
import { LocalStubEmbeddingProvider } from "./providers/local-stub.provider.js";

@Module({
	providers: [
		{
			provide: EMBEDDING_CONFIG,
			useFactory: () => new EmbeddingConfig(),
		},
		{
			// For now, always use local stub provider
			// TODO: Add factory to switch based on EMBEDDING_PROVIDER env var
			provide: EMBEDDING_PROVIDER,
			useFactory: () => new LocalStubEmbeddingProvider(),
		},
		{
			provide: EMBEDDING_SERVICE,
			useFactory: (
				config: EmbeddingConfig,
				provider: LocalStubEmbeddingProvider,
				logger: LoggerService,
			) => new EmbeddingService(config, provider, logger),
			inject: [EMBEDDING_CONFIG, EMBEDDING_PROVIDER, LOGGER],
		},
	],
	exports: [EMBEDDING_SERVICE, EMBEDDING_CONFIG],
})
export class EmbeddingModule {}
