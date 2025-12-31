import {
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
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

		this.logger.info("Initializing S3 client for OCR worker", {
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
	 * Fetch raw bytes from S3/MinIO using s3:// URI
	 */
	async getBytes(uri: string): Promise<Buffer> {
		const { bucket, key } = this.parseUri(uri);
		const client = this.getClient();

		this.logger.debug("Fetching content from storage", { bucket, key });

		const command = new GetObjectCommand({ Bucket: bucket, Key: key });
		const response = await client.send(command);

		if (!response.Body) {
			throw new Error(`Empty response from S3 for ${uri}`);
		}

		return Buffer.from(await response.Body.transformToByteArray());
	}

	/**
	 * Store extracted text in MinIO and return the URI
	 */
	async storeText(
		requestId: string,
		tenantId: string,
		text: string,
	): Promise<string> {
		const client = this.getClient();
		const key = `${tenantId}/${requestId}.txt`;

		this.logger.debug("Storing OCR text to storage", {
			bucket: this.config.ocrTextBucket,
			key,
			text_length: text.length,
		});

		const command = new PutObjectCommand({
			Bucket: this.config.ocrTextBucket,
			Key: key,
			Body: text,
			ContentType: "text/plain; charset=utf-8",
		});

		await client.send(command);

		const uri = `s3://${this.config.ocrTextBucket}/${key}`;
		this.logger.debug("Stored OCR text", { uri });

		return uri;
	}

	/**
	 * Fetch text from storage URI
	 */
	async getText(uri: string): Promise<string> {
		const buffer = await this.getBytes(uri);
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
