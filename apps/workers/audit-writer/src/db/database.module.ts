import {
	LOGGER,
	type LoggerService,
	WORKER_CONFIG,
} from "@lattice/worker-base";
import {
	type DynamicModule,
	Inject,
	Module,
	type OnModuleDestroy,
} from "@nestjs/common";
import pg from "pg";

export const DB_POOL = "DB_POOL";

@Module({})
export class DatabaseModule implements OnModuleDestroy {
	private pool: pg.Pool | null = null;

	constructor(@Inject(LOGGER) private readonly logger: LoggerService) {}

	static forRoot(): DynamicModule {
		return {
			module: DatabaseModule,
			global: true,
			providers: [
				{
					provide: DB_POOL,
					useFactory: async (
						logger: LoggerService,
						config: { database?: { url?: string } },
					): Promise<pg.Pool> => {
						const connectionString =
							config.database?.url ??
							process.env["DATABASE_URL"] ??
							"postgresql://lattice:lattice_dev_password@localhost:5432/lattice"; // pragma: allowlist secret

						logger.info("Connecting to Postgres", {
							host: new URL(connectionString).hostname,
						});

						const pool = new pg.Pool({
							connectionString,
							max: 10,
							idleTimeoutMillis: 30000,
							connectionTimeoutMillis: 5000,
						});

						// Verify connection
						const client = await pool.connect();
						await client.query("SELECT 1");
						client.release();

						logger.info("Connected to Postgres successfully");
						return pool;
					},
					inject: [LOGGER, WORKER_CONFIG],
				},
			],
			exports: [DB_POOL],
		};
	}

	async onModuleDestroy(): Promise<void> {
		if (this.pool) {
			await this.pool.end();
			this.logger.info("Postgres pool closed");
		}
	}
}
