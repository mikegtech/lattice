import { Module } from '@nestjs/common';
import { MailChunkerService } from './worker.service.js';
import { ChunkRepository } from '../db/chunk.repository.js';
import { ChunkingModule } from '../chunking/chunking.module.js';

@Module({
  imports: [ChunkingModule],
  providers: [MailChunkerService, ChunkRepository],
  exports: [MailChunkerService],
})
export class WorkerModule {}
