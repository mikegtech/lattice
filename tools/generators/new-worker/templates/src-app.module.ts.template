import { Module } from '@nestjs/common';
import {
  WorkerConfigModule,
  TelemetryModule,
  KafkaModule,
  HealthModule,
  LifecycleModule,
} from '@lattice/worker-base';
import { DatabaseModule } from './db/database.module.js';
import { WorkerModule } from './worker/worker.module.js';

@Module({
  imports: [
    // Core infrastructure modules from worker-base
    WorkerConfigModule,
    TelemetryModule,
    LifecycleModule,
    KafkaModule,
    HealthModule,

    // Worker-specific modules
    DatabaseModule,
    WorkerModule,
  ],
})
export class AppModule {}
