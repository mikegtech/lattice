import {
	LOGGER,
	type LoggerService,
	WORKER_CONFIG,
	type WorkerConfig,
} from "@lattice/worker-base";
import { Global, Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import pg from "pg";

export const DB_POOL = Symbol("DB_POOL");

@Global()
@Module({
	providers: [
		{
			provide: DB_POOL,
			useFactory: (config: WorkerConfig, logger: LoggerService) => {
				const databaseUrl = process.env["DATABASE_URL"];
				if (!databaseUrl) {
					throw new Error("DATABASE_URL environment variable is required");
				}

				const pool = new pg.Pool({
					connectionString: databaseUrl,
					max: 10,
					idleTimeoutMillis: 30000,
					connectionTimeoutMillis: 5000,
				});

				pool.on("error", (err) => {
					logger.error("Unexpected database pool error", err.stack, "{}");
				});

				logger.info("Database pool created");
				return pool;
			},
			inject: [WORKER_CONFIG, LOGGER],
		},
	],
	exports: [DB_POOL],
})
export class DatabaseModule implements OnModuleDestroy {
	constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

	async onModuleDestroy() {
		await this.pool.end();
	}
}
