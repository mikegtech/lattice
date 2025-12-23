import { Module, Global, OnModuleInit, Inject } from '@nestjs/common';
import { TelemetryService } from './telemetry.service.js';
import { LoggerService, LOGGER } from './logger.service.js';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module.js';

@Global()
@Module({
  providers: [
    TelemetryService,
    {
      provide: LOGGER,
      useFactory: (config: WorkerConfig) => {
        return new LoggerService(config);
      },
      inject: [WORKER_CONFIG],
    },
  ],
  exports: [TelemetryService, LOGGER],
})
export class TelemetryModule implements OnModuleInit {
  constructor(
    private readonly telemetry: TelemetryService,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  onModuleInit() {
    this.telemetry.initialize(this.config);
  }
}
