import {
	DeleteObjectCommand,
	DeleteObjectsCommand,
	type ObjectIdentifier,
	S3Client,
} from "@aws-sdk/client-s3";
import { LOGGER, type LoggerService } from "@lattice/worker-base";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { STORAGE_CONFIG, type StorageConfig } from "./storage.config.js";

export const STORAGE_SERVICE = "STORAGE_SERVICE";

export interface StorageDeleteResult {
	deleted: number;
	errors: string[];
}

interface ParsedUri {
	bucket: string;
	key: string;
}

@Injectable()
export class StorageService implements OnModuleDestroy {
	private client: S3Client | null = null;

	constructor(
		@Inject(STORAGE_CONFIG) private readonly config: StorageConfig,
		@Inject(LOGGER) private readonly logger: LoggerService,
	) {}

	/**
	 * Get or create S3 client (lazy initialization)
	 */
	private getClient(): S3Client {
		if (this.client) {
			return this.client;
		}

		this.logger.info("Initializing S3 client", {
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
	 * Parse S3 URI into bucket and key
	 * Format: s3://bucket/key/path/to/object
	 */
	private parseUri(uri: string): ParsedUri | null {
		if (!uri.startsWith("s3://")) {
			this.logger.warn("Invalid S3 URI format", { uri });
			return null;
		}

		const withoutProtocol = uri.slice(5); // Remove "s3://"
		const slashIndex = withoutProtocol.indexOf("/");

		if (slashIndex === -1) {
			this.logger.warn("S3 URI missing key", { uri });
			return null;
		}

		return {
			bucket: withoutProtocol.slice(0, slashIndex),
			key: withoutProtocol.slice(slashIndex + 1),
		};
	}

	/**
	 * Delete a single object from S3
	 * Returns success even if object doesn't exist (idempotent)
	 */
	async deleteObject(uri: string): Promise<StorageDeleteResult> {
		const parsed = this.parseUri(uri);
		if (!parsed) {
			return { deleted: 0, errors: [`Invalid URI: ${uri}`] };
		}

		const client = this.getClient();

		try {
			await client.send(
				new DeleteObjectCommand({
					Bucket: parsed.bucket,
					Key: parsed.key,
				}),
			);

			this.logger.debug("Deleted object from storage", {
				bucket: parsed.bucket,
				key: parsed.key,
			});

			return { deleted: 1, errors: [] };
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const errorCode =
				error instanceof Error && "name" in error ? error.name : "Unknown";

			// NoSuchKey is acceptable - object already deleted
			if (errorCode === "NoSuchKey") {
				this.logger.debug("Object already deleted", {
					bucket: parsed.bucket,
					key: parsed.key,
				});
				return { deleted: 1, errors: [] };
			}

			this.logger.warn("Failed to delete object", {
				bucket: parsed.bucket,
				key: parsed.key,
				error: errorMsg,
			});

			return { deleted: 0, errors: [errorMsg] };
		}
	}

	/**
	 * Delete multiple objects from S3
	 * Groups by bucket for efficient batch deletion (S3 supports up to 1000 per request)
	 * Returns success even if objects don't exist (idempotent)
	 */
	async deleteObjects(uris: string[]): Promise<StorageDeleteResult> {
		if (uris.length === 0) {
			return { deleted: 0, errors: [] };
		}

		// Group URIs by bucket
		const bucketGroups = new Map<string, ObjectIdentifier[]>();
		const parseErrors: string[] = [];

		for (const uri of uris) {
			const parsed = this.parseUri(uri);
			if (!parsed) {
				parseErrors.push(`Invalid URI: ${uri}`);
				continue;
			}

			const existing = bucketGroups.get(parsed.bucket) ?? [];
			existing.push({ Key: parsed.key });
			bucketGroups.set(parsed.bucket, existing);
		}

		const client = this.getClient();
		let totalDeleted = 0;
		const allErrors: string[] = [...parseErrors];

		// Process each bucket's objects
		for (const [bucket, objects] of bucketGroups) {
			// S3 DeleteObjects supports max 1000 keys per request
			const chunks = this.chunkArray(objects, 1000);

			for (const chunk of chunks) {
				try {
					const result = await client.send(
						new DeleteObjectsCommand({
							Bucket: bucket,
							Delete: {
								Objects: chunk,
								Quiet: false,
							},
						}),
					);

					// Count successful deletions
					const deleted = result.Deleted?.length ?? 0;
					totalDeleted += deleted;

					// Collect errors (excluding NoSuchKey which is acceptable)
					if (result.Errors && result.Errors.length > 0) {
						for (const err of result.Errors) {
							if (err.Code !== "NoSuchKey") {
								allErrors.push(
									`${bucket}/${err.Key}: ${err.Code} - ${err.Message}`,
								);
							} else {
								// NoSuchKey still counts as "deleted" (idempotent)
								totalDeleted += 1;
							}
						}
					}

					this.logger.debug("Batch deleted objects from storage", {
						bucket,
						requested: chunk.length,
						deleted,
						errors: result.Errors?.length ?? 0,
					});
				} catch (error) {
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					this.logger.warn("Failed to batch delete objects", {
						bucket,
						count: chunk.length,
						error: errorMsg,
					});
					allErrors.push(`Bucket ${bucket}: ${errorMsg}`);
				}
			}
		}

		return { deleted: totalDeleted, errors: allErrors };
	}

	/**
	 * Split array into chunks of specified size
	 */
	private chunkArray<T>(array: T[], size: number): T[][] {
		const chunks: T[][] = [];
		for (let i = 0; i < array.length; i += size) {
			chunks.push(array.slice(i, i + size));
		}
		return chunks;
	}

	/**
	 * Health check - verifies S3 client can be created
	 */
	async healthCheck(): Promise<boolean> {
		try {
			this.getClient();
			return true;
		} catch {
			return false;
		}
	}

	async onModuleDestroy(): Promise<void> {
		if (this.client) {
			this.client.destroy();
			this.client = null;
		}
	}
}
