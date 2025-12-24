import { Module } from "@nestjs/common";
import { ChunkingModule } from "../chunking/chunking.module.js";
import { ChunkRepository } from "../db/chunk.repository.js";
import { MailChunkerService } from "./worker.service.js";

@Module({
	imports: [ChunkingModule],
	providers: [MailChunkerService, ChunkRepository],
	exports: [MailChunkerService],
})
export class WorkerModule {}
