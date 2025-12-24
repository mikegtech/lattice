import { Module, Global, OnModuleDestroy, Inject } from '@nestjs/common';
import pg from 'pg';
import { WORKER_CONFIG, type WorkerConfig, LOGGER, type LoggerService } from '@lattice/worker-base';

export const DB_POOL = Symbol('DB_POOL');
export const DATABASE_HEALTH = Symbol('DATABASE_HEALTH');

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      useFactory: (config: WorkerConfig, logger: LoggerService) => {
        const databaseUrl = process.env['DATABASE_URL'];
        if (!databaseUrl) {
          throw new Error('DATABASE_URL environment variable is required');
        }

        const pool = new pg.Pool({
          connectionString: databaseUrl,
          max: 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        });

        pool.on('error', (err) => {
          logger.error('Unexpected database pool error', err.stack, '{}');
        });

        logger.log('Database pool created');
        return pool;
      },
      inject: [WORKER_CONFIG, LOGGER],
    },
    {
      provide: DATABASE_HEALTH,
      useFactory: (pool: pg.Pool) => ({
        check: async (): Promise<boolean> => {
          try {
            const client = await pool.connect();
            await client.query('SELECT 1');
            client.release();
            return true;
          } catch {
            return false;
          }
        },
      }),
      inject: [DB_POOL],
    },
  ],
  exports: [DB_POOL, DATABASE_HEALTH],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async onModuleDestroy() {
    await this.pool.end();
  }
}
