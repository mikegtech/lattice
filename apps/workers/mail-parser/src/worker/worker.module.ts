import { Module } from "@nestjs/common";
import { EmailRepository } from "../db/email.repository.js";
import { ParserService } from "./parser.service.js";
import { MailParserService } from "./worker.service.js";

@Module({
	providers: [MailParserService, EmailRepository, ParserService],
	exports: [MailParserService],
})
export class WorkerModule {}
