import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Module } from "@nestjs/common";
import { EXTRACTION_SERVICE, ExtractionService } from "./extraction.service.js";

@Module({
	providers: [
		{
			provide: EXTRACTION_SERVICE,
			useFactory: (logger: LoggerService) => new ExtractionService(logger),
			inject: [LOGGER],
		},
	],
	exports: [EXTRACTION_SERVICE],
})
export class ExtractionModule {}
