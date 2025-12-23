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
    // Core infrastructure
    WorkerConfigModule.forRoot({
      envFilePath: '.env',
    }),
    TelemetryModule,
    LifecycleModule,

    // Kafka with expected schema version
    KafkaModule.forRoot({
      expectedSchemaVersion: 'v1',
    }),

    // Health checks
    HealthModule,

    // Database
    DatabaseModule,

    // Worker business logic
    WorkerModule,
  ],
})
export class AppModule {}
