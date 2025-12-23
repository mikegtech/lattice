import { Module, Global, DynamicModule } from '@nestjs/common';
import { KafkaService } from './kafka.service.js';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module.js';

export interface KafkaModuleOptions {
  expectedSchemaVersion?: string;
}

@Global()
@Module({})
export class KafkaModule {
  static forRoot(options: KafkaModuleOptions = {}): DynamicModule {
    return {
      module: KafkaModule,
      providers: [
        {
          provide: 'KAFKA_OPTIONS',
          useValue: options,
        },
        KafkaService,
      ],
      exports: [KafkaService],
    };
  }
}
