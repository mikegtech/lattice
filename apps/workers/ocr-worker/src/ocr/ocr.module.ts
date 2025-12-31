import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import { TESSERACT_ENGINE, TesseractEngine } from "./tesseract.engine.js";

@Module({
	providers: [
		{
			provide: TESSERACT_ENGINE,
			useFactory: (logger: LoggerService) => new TesseractEngine(logger),
			inject: [LOGGER],
		},
	],
	exports: [TESSERACT_ENGINE],
})
export class OcrModule {}
