import {
	LOGGER,
	type LoggerService,
	TelemetryService,
} from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import { EMBEDDING_CONFIG, EmbeddingConfig } from "./embedding.config.js";
import { EMBEDDING_SERVICE, EmbeddingService } from "./embedding.service.js";
import { E5EmbeddingProvider, E5_CONFIG } from "./providers/e5.provider.js";
import {
	EMBEDDING_PROVIDER,
	type EmbeddingProvider,
} from "./providers/embedding-provider.interface.js";
import { LocalStubEmbeddingProvider } from "./providers/local-stub.provider.js";
import {
	NOMIC_CONFIG,
	NomicEmbeddingProvider,
} from "./providers/nomic.provider.js";
import {
	OPENAI_CONFIG,
	OpenAIEmbeddingProvider,
} from "./providers/openai.provider.js";

@Module({
	providers: [
		{
			provide: EMBEDDING_CONFIG,
			useFactory: () => new EmbeddingConfig(),
		},
		// Provider-specific configs
		{
			provide: NOMIC_CONFIG,
			useFactory: (config: EmbeddingConfig) => ({
				endpoint: config.nomicEndpoint,
				prefix: config.nomicPrefix,
				timeoutMs: config.timeoutMs,
			}),
			inject: [EMBEDDING_CONFIG],
		},
		{
			provide: E5_CONFIG,
			useFactory: (config: EmbeddingConfig) => ({
				endpoint: config.e5Endpoint,
				prefix: config.e5Prefix,
				timeoutMs: config.timeoutMs,
			}),
			inject: [EMBEDDING_CONFIG],
		},
		{
			provide: OPENAI_CONFIG,
			useFactory: (config: EmbeddingConfig) => ({
				apiKey: config.openaiApiKey,
				model: config.openaiModel,
				dimensions: config.openaiDimensions,
				timeoutMs: config.timeoutMs,
			}),
			inject: [EMBEDDING_CONFIG],
		},
		// Provider factory - creates the correct provider based on config
		{
			provide: EMBEDDING_PROVIDER,
			useFactory: (
				config: EmbeddingConfig,
				telemetry: TelemetryService,
				logger: LoggerService,
				nomicConfig: { endpoint: string; prefix: string; timeoutMs: number },
				e5Config: { endpoint: string; prefix: string; timeoutMs: number },
				openaiConfig: {
					apiKey: string;
					model: string;
					dimensions: number;
					timeoutMs: number;
				},
			): EmbeddingProvider => {
				logger.info("Initializing embedding provider", {
					provider: config.provider,
					version: config.embeddingVersion,
				});

				switch (config.provider) {
					case "nomic":
						logger.info("Using Nomic embedding provider", {
							endpoint: nomicConfig.endpoint,
							prefix: nomicConfig.prefix,
						});
						return new NomicEmbeddingProvider(nomicConfig, telemetry);

					case "e5":
						logger.info("Using E5 embedding provider", {
							endpoint: e5Config.endpoint,
							prefix: e5Config.prefix,
						});
						return new E5EmbeddingProvider(e5Config, telemetry);

					case "openai":
						if (!openaiConfig.apiKey) {
							logger.warn(
								"OpenAI API key not configured, falling back to local-stub",
							);
							return new LocalStubEmbeddingProvider();
						}
						logger.info("Using OpenAI embedding provider", {
							model: openaiConfig.model,
							dimensions: openaiConfig.dimensions,
						});
						return new OpenAIEmbeddingProvider(openaiConfig, telemetry);

					default:
						logger.info("Using local stub embedding provider");
						return new LocalStubEmbeddingProvider();
				}
			},
			inject: [
				EMBEDDING_CONFIG,
				TelemetryService,
				LOGGER,
				NOMIC_CONFIG,
				E5_CONFIG,
				OPENAI_CONFIG,
			],
		},
		{
			provide: EMBEDDING_SERVICE,
			useFactory: (
				config: EmbeddingConfig,
				provider: EmbeddingProvider,
				logger: LoggerService,
			) => new EmbeddingService(config, provider, logger),
			inject: [EMBEDDING_CONFIG, EMBEDDING_PROVIDER, LOGGER],
		},
	],
	exports: [EMBEDDING_SERVICE, EMBEDDING_CONFIG],
})
export class EmbeddingModule {}
