import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { LOGGER, LoggerService } from '@lattice/worker-base';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  // Use custom logger
  const logger = app.get<LoggerService>(LOGGER);
  app.useLogger(logger);

  // Start HTTP server for health checks
  const port = process.env['HEALTH_PORT'] ?? 3001;
  await app.listen(port);

  logger.log(`Mail Chunker worker started, health endpoint on port ${port}`);
}

bootstrap().catch((err) => {
  console.error('Failed to start Mail Chunker worker:', err);
  process.exit(1);
});
