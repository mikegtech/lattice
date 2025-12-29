import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
	const app = await NestFactory.create(AppModule, {
		logger: ["error", "warn", "log"],
	});

	// Health check endpoint
	const port = process.env["PORT"] ?? 3000;
	await app.listen(port);

	console.log(`mail-extractor listening on port ${port}`);
}

bootstrap().catch((err) => {
	console.error("Failed to start mail-extractor:", err);
	process.exit(1);
});
