import "reflect-metadata";
import {
	EVENT_LOGGER,
	type EventLogger,
	LOGGER,
	type LoggerService,
} from "@lattice/worker-base";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap() {
	const app = await NestFactory.create(AppModule, {
		bufferLogs: true,
	});

	const logger = app.get<LoggerService>(LOGGER);
	const eventLogger = app.get<EventLogger>(EVENT_LOGGER);
	app.useLogger(logger);

	const port = process.env["HEALTH_PORT"] ?? 3003;
	await app.listen(port);

	// Emit single structured startup event
	eventLogger.workerStarted();
}

bootstrap().catch((err) => {
	console.error("Failed to start Mail Upserter worker:", err);
	process.exit(1);
});
