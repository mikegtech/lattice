import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import { CHUNKING_CONFIG, ChunkingConfig } from "./chunking.config.js";
import { ChunkingService } from "./chunking.service.js";
import {
	SECTION_CLASSIFIER_SERVICE,
	SectionClassifierService,
} from "./section-classifier.service.js";
import { TOKENIZER_SERVICE, TokenizerService } from "./tokenizer.service.js";

export const CHUNKING_SERVICE = "CHUNKING_SERVICE";

@Module({
	providers: [
		{
			provide: CHUNKING_CONFIG,
			useFactory: () => new ChunkingConfig(),
		},
		{
			provide: TOKENIZER_SERVICE,
			useFactory: () => new TokenizerService(),
		},
		{
			provide: SECTION_CLASSIFIER_SERVICE,
			useFactory: () => new SectionClassifierService(),
		},
		{
			provide: CHUNKING_SERVICE,
			useFactory: (
				config: ChunkingConfig,
				tokenizer: TokenizerService,
				classifier: SectionClassifierService,
				logger: LoggerService,
			) => new ChunkingService(config, tokenizer, classifier, logger),
			inject: [
				CHUNKING_CONFIG,
				TOKENIZER_SERVICE,
				SECTION_CLASSIFIER_SERVICE,
				LOGGER,
			],
		},
	],
	exports: [CHUNKING_SERVICE, CHUNKING_CONFIG],
})
export class ChunkingModule {}
