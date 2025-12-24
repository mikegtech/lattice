import "reflect-metadata";
import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap() {
	const app = await NestFactory.create(AppModule, {
		bufferLogs: true,
	});

	// Use our custom logger
	const logger = app.get<LoggerService>(LOGGER);
	app.useLogger(logger);

	// Get health port from config
	const port = process.env["HEALTH_PORT"] ?? 3000;

	await app.listen(port);
	logger.info(`Health endpoints available on port ${port}`);
}

bootstrap().catch((error) => {
	console.error("Failed to start application:", error);
	process.exit(1);
});
