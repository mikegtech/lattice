import { Injectable } from "@nestjs/common";

export const MILVUS_CONFIG = "MILVUS_CONFIG";

/**
 * Milvus configuration from environment variables
 */
@Injectable()
export class MilvusConfig {
	/** Milvus host */
	readonly host: string;

	/** Milvus port */
	readonly port: number;

	/** Collection name for email chunks */
	readonly collection: string;

	/** Vector dimension (must match embedding model) */
	readonly dimension: number;

	/** Index type (HNSW, IVF_FLAT, etc.) */
	readonly indexType: string;

	/** HNSW M parameter (number of connections per layer) */
	readonly hnswM: number;

	/** HNSW efConstruction parameter */
	readonly hnswEfConstruction: number;

	/** Metric type (L2, IP, COSINE) */
	readonly metricType: string;

	/** Connection timeout in ms */
	readonly connectTimeoutMs: number;

	/** Batch size for upserts */
	readonly batchSize: number;

	constructor() {
		this.host = process.env["MILVUS_HOST"] ?? "milvus";
		this.port = Number.parseInt(process.env["MILVUS_PORT"] ?? "19530", 10);
		this.collection = process.env["MILVUS_COLLECTION"] ?? "email_chunks_v1";
		this.dimension = Number.parseInt(process.env["MILVUS_DIM"] ?? "384", 10);
		this.indexType = process.env["MILVUS_INDEX_TYPE"] ?? "HNSW";
		this.hnswM = Number.parseInt(process.env["MILVUS_HNSW_M"] ?? "16", 10);
		this.hnswEfConstruction = Number.parseInt(
			process.env["MILVUS_HNSW_EF_CONSTRUCTION"] ?? "256",
			10,
		);
		this.metricType = process.env["MILVUS_METRIC_TYPE"] ?? "COSINE";
		this.connectTimeoutMs = Number.parseInt(
			process.env["MILVUS_CONNECT_TIMEOUT_MS"] ?? "10000",
			10,
		);
		this.batchSize = Number.parseInt(
			process.env["MILVUS_BATCH_SIZE"] ?? "100",
			10,
		);
	}

	/** Get Milvus address in host:port format */
	get address(): string {
		return `${this.host}:${this.port}`;
	}
}
