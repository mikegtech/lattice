import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { STORAGE_CONFIG, type StorageConfig } from "./storage.config.js";

export const STORAGE_SERVICE = "STORAGE_SERVICE";

@Injectable()
export class StorageService implements OnModuleDestroy {
	private client: S3Client | null = null;

	constructor(
		@Inject(STORAGE_CONFIG) private readonly config: StorageConfig,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	private getClient(): S3Client {
		if (this.client) {
			return this.client;
		}

		this.logger.info("Initializing S3 client for mail-ocr-normalizer", {
			endpoint: this.config.endpoint ?? "AWS S3",
			region: this.config.region,
		});

		this.client = new S3Client({
			endpoint: this.config.endpoint,
			region: this.config.region,
			credentials: {
				accessKeyId: this.config.accessKeyId,
				secretAccessKey: this.config.secretAccessKey,
			},
			forcePathStyle: this.config.forcePathStyle,
		});

		return this.client;
	}

	/**
	 * Fetch text from storage URI
	 */
	async getText(uri: string): Promise<string> {
		const { bucket, key } = this.parseUri(uri);
		const client = this.getClient();

		this.logger.debug("Fetching OCR text from storage", { bucket, key });

		const command = new GetObjectCommand({ Bucket: bucket, Key: key });
		const response = await client.send(command);

		if (!response.Body) {
			throw new Error(`Empty response from S3 for ${uri}`);
		}

		const buffer = Buffer.from(await response.Body.transformToByteArray());
		return buffer.toString("utf-8");
	}

	/**
	 * Parse s3://bucket/key URI into components
	 */
	private parseUri(uri: string): { bucket: string; key: string } {
		const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
		if (!match || !match[1] || !match[2]) {
			throw new Error(`Invalid S3 URI format: ${uri}`);
		}
		return { bucket: match[1], key: match[2] };
	}

	async onModuleDestroy(): Promise<void> {
		if (this.client) {
			this.client.destroy();
			this.client = null;
		}
	}
}
