export const MILVUS_CONFIG = "MILVUS_CONFIG";

export interface MilvusConfig {
	host: string;
	port: number;
	address: string;
	collection: string;
	connectTimeoutMs: number;
}

export function createMilvusConfig(): MilvusConfig {
	const host = process.env["MILVUS_HOST"] ?? "localhost";
	const port = Number.parseInt(process.env["MILVUS_PORT"] ?? "19530", 10);

	return {
		host,
		port,
		address: `${host}:${port}`,
		collection: process.env["MILVUS_COLLECTION"] ?? "email_chunks_v1",
		connectTimeoutMs: Number.parseInt(
			process.env["MILVUS_CONNECT_TIMEOUT_MS"] ?? "10000",
			10,
		),
	};
}
