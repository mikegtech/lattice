import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable } from "@nestjs/common";

export const STORAGE_CONFIG = Symbol("STORAGE_CONFIG");

export interface StorageConfig {
	endpoint?: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle: boolean;
}

@Injectable()
export class StorageConfigFactory {
	constructor(@Inject(LOGGER) private readonly logger: LoggerService) {}

	create(): StorageConfig {
		const config: StorageConfig = {
			endpoint: process.env["S3_ENDPOINT"],
			region: process.env["S3_REGION"] ?? "us-east-1",
			accessKeyId: process.env["S3_ACCESS_KEY_ID"] ?? "",
			secretAccessKey: process.env["S3_SECRET_ACCESS_KEY"] ?? "",
			forcePathStyle: process.env["S3_FORCE_PATH_STYLE"] === "true",
		};

		if (!config.accessKeyId || !config.secretAccessKey) {
			this.logger.warn(
				"S3 credentials not configured - storage operations will fail",
			);
		}

		return config;
	}
}
