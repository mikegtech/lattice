import { Module } from "@nestjs/common";
import { ChunkingConfig } from "./chunking.config.js";
import { ChunkingService } from "./chunking.service.js";
import { SectionClassifierService } from "./section-classifier.service.js";
import { TokenizerService } from "./tokenizer.service.js";

@Module({
	providers: [
		ChunkingConfig,
		TokenizerService,
		SectionClassifierService,
		ChunkingService,
	],
	exports: [ChunkingService, ChunkingConfig],
})
export class ChunkingModule {}
