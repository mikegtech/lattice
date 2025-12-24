import {
	LOGGER,
	type LoggerService,
	WORKER_CONFIG,
	type WorkerConfig,
} from "@lattice/worker-base";
import { Global, Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import pg from "pg";

export const DATABASE_HEALTH = "DATABASE_HEALTH";

export interface DatabaseHealthCheck {
	check(): Promise<boolean>;
}

const { Pool } = pg;

export const DB_POOL = "DB_POOL";

@Global()
@Module({
	providers: [
		{
			provide: DB_POOL,
			useFactory: (config: WorkerConfig) => {
				if (!config.databaseUrl) {
					throw new Error("DATABASE_URL is required");
				}

				return new Pool({
					connectionString: config.databaseUrl,
					min: 2,
					max: 10,
					idleTimeoutMillis: 30000,
					connectionTimeoutMillis: 10000,
				});
			},
			inject: [WORKER_CONFIG],
		},
		{
			provide: DATABASE_HEALTH,
			useFactory: (pool: pg.Pool): DatabaseHealthCheck => ({
				async check(): Promise<boolean> {
					try {
						await pool.query("SELECT 1");
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
	constructor(
		@Inject(DB_POOL) private readonly pool: pg.Pool,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	async onModuleDestroy(): Promise<void> {
		this.logger.info("Closing database pool");
		await this.pool.end();
	}
}
