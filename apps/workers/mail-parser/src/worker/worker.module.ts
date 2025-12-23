import { Module } from '@nestjs/common';
import { MailParserService } from './worker.service.js';
import { EmailRepository } from '../db/email.repository.js';
import { ParserService } from './parser.service.js';

@Module({
  providers: [
    MailParserService,
    EmailRepository,
    ParserService,
  ],
  exports: [MailParserService],
})
export class WorkerModule {}
