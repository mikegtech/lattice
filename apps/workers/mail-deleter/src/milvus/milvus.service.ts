import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { MilvusClient } from "@zilliz/milvus2-sdk-node";
import { MILVUS_CONFIG, type MilvusConfig } from "./milvus.config.js";

export const MILVUS_SERVICE = "MILVUS_SERVICE";

export interface DeleteResult {
	deleted: number;
	errors: string[];
}

@Injectable()
export class MilvusService implements OnModuleDestroy {
	private client: MilvusClient | null = null;

	constructor(
		@Inject(MILVUS_CONFIG) private readonly config: MilvusConfig,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	/**
	 * Get or create Milvus client
	 */
	private async getClient(): Promise<MilvusClient> {
		if (this.client) {
			return this.client;
		}

		this.logger.info("Connecting to Milvus", {
			address: this.config.address,
			collection: this.config.collection,
		});

		this.client = new MilvusClient({
			address: this.config.address,
			timeout: this.config.connectTimeoutMs,
		});

		const health = await this.client.checkHealth();
		if (!health.isHealthy) {
			throw new Error(`Milvus is not healthy: ${JSON.stringify(health)}`);
		}

		this.logger.info("Connected to Milvus successfully");
		return this.client;
	}

	/**
	 * Delete vectors by primary keys
	 */
	async deleteByPKs(pks: string[]): Promise<DeleteResult> {
		if (pks.length === 0) {
			return { deleted: 0, errors: [] };
		}

		const client = await this.getClient();
		const errors: string[] = [];

		try {
			// Build filter expression for PKs
			const pkFilter = pks.map((pk) => `"${pk}"`).join(",");
			const expr = `pk in [${pkFilter}]`;

			const result = await client.delete({
				collection_name: this.config.collection,
				filter: expr,
			});

			if (result.status.error_code !== "Success") {
				errors.push(result.status.reason || "Unknown Milvus error");
				return { deleted: 0, errors };
			}

			this.logger.debug("Deleted vectors by PK", {
				count: pks.length,
				collection: this.config.collection,
			});

			return { deleted: pks.length, errors: [] };
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			errors.push(errorMsg);
			this.logger.error("Failed to delete vectors by PK", errorMsg, "{}");
			return { deleted: 0, errors };
		}
	}

	/**
	 * Delete vectors by email IDs
	 */
	async deleteByEmailIds(emailIds: string[]): Promise<DeleteResult> {
		if (emailIds.length === 0) {
			return { deleted: 0, errors: [] };
		}

		const client = await this.getClient();
		const errors: string[] = [];

		try {
			// Build filter expression for email_ids
			const emailFilter = emailIds.map((id) => `"${id}"`).join(",");
			const expr = `email_id in [${emailFilter}]`;

			const result = await client.delete({
				collection_name: this.config.collection,
				filter: expr,
			});

			if (result.status.error_code !== "Success") {
				errors.push(result.status.reason || "Unknown Milvus error");
				return { deleted: 0, errors };
			}

			this.logger.debug("Deleted vectors by email_id", {
				email_count: emailIds.length,
				collection: this.config.collection,
			});

			// Note: delete by filter doesn't return exact count
			return { deleted: emailIds.length, errors: [] };
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			errors.push(errorMsg);
			this.logger.error("Failed to delete vectors by email_id", errorMsg, "{}");
			return { deleted: 0, errors };
		}
	}

	/**
	 * Delete vectors by tenant and account
	 */
	async deleteByAccount(
		tenantId: string,
		accountId: string,
	): Promise<DeleteResult> {
		const client = await this.getClient();
		const errors: string[] = [];

		try {
			const expr = `tenant_id == "${tenantId}" && account_id == "${accountId}"`;

			const result = await client.delete({
				collection_name: this.config.collection,
				filter: expr,
			});

			if (result.status.error_code !== "Success") {
				errors.push(result.status.reason || "Unknown Milvus error");
				return { deleted: 0, errors };
			}

			this.logger.debug("Deleted vectors by account", {
				tenant_id: tenantId,
				account_id: accountId,
				collection: this.config.collection,
			});

			return { deleted: -1, errors: [] }; // -1 indicates unknown count
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			errors.push(errorMsg);
			this.logger.error("Failed to delete vectors by account", errorMsg, "{}");
			return { deleted: 0, errors };
		}
	}

	/**
	 * Delete vectors by alias
	 */
	async deleteByAlias(
		tenantId: string,
		accountId: string,
		alias: string,
	): Promise<DeleteResult> {
		const client = await this.getClient();
		const errors: string[] = [];

		try {
			const expr = `tenant_id == "${tenantId}" && account_id == "${accountId}" && alias == "${alias}"`;

			const result = await client.delete({
				collection_name: this.config.collection,
				filter: expr,
			});

			if (result.status.error_code !== "Success") {
				errors.push(result.status.reason || "Unknown Milvus error");
				return { deleted: 0, errors };
			}

			this.logger.debug("Deleted vectors by alias", {
				tenant_id: tenantId,
				account_id: accountId,
				alias,
				collection: this.config.collection,
			});

			return { deleted: -1, errors: [] };
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			errors.push(errorMsg);
			this.logger.error("Failed to delete vectors by alias", errorMsg, "{}");
			return { deleted: 0, errors };
		}
	}

	/**
	 * Health check
	 */
	async healthCheck(): Promise<boolean> {
		try {
			const client = await this.getClient();
			const health = await client.checkHealth();
			return health.isHealthy;
		} catch {
			return false;
		}
	}

	async onModuleDestroy(): Promise<void> {
		if (this.client) {
			await this.client.closeConnection();
			this.client = null;
		}
	}
}
