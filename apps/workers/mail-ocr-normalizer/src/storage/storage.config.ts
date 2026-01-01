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
			endpoint: process.env["MINIO_ENDPOINT"],
			region: process.env["S3_REGION"] ?? "us-east-1",
			accessKeyId: process.env["MINIO_ACCESS_KEY"] ?? "",
			secretAccessKey: process.env["MINIO_SECRET_KEY"] ?? "",
			forcePathStyle: process.env["S3_FORCE_PATH_STYLE"] === "true",
		};

		if (!config.accessKeyId || !config.secretAccessKey) {
			this.logger.warn(
				"MinIO credentials not configured - storage operations will fail",
			);
		}

		return config;
	}
}
