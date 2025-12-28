export const STORAGE_CONFIG = "STORAGE_CONFIG";

export interface StorageConfig {
	endpoint: string | undefined;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	forcePathStyle: boolean;
}

export function createStorageConfig(): StorageConfig {
	return {
		endpoint: process.env["MINIO_ENDPOINT"] ?? process.env["S3_ENDPOINT"],
		accessKeyId:
			process.env["MINIO_ACCESS_KEY"] ?? process.env["AWS_ACCESS_KEY_ID"] ?? "",
		secretAccessKey:
			process.env["MINIO_SECRET_KEY"] ??
			process.env["AWS_SECRET_ACCESS_KEY"] ??
			"",
		region: process.env["AWS_REGION"] ?? "us-east-1",
		// Force path style for MinIO (bucket.endpoint vs endpoint/bucket)
		forcePathStyle: process.env["S3_FORCE_PATH_STYLE"] !== "false",
	};
}
