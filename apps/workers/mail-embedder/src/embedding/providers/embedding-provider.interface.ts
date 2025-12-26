/**
 * Result of an embedding request
 */
export interface EmbeddingResult {
	/** The embedding vector */
	vector: number[];
	/** Model that generated the embedding */
	model: string;
	/** Vector dimensions */
	dimensions: number;
	/** Token count used (if available) */
	tokenCount?: number;
}

/**
 * Input for a single embedding request
 */
export interface EmbeddingInput {
	/** Unique ID for tracking */
	id: string;
	/** Text to embed */
	text: string;
}

/**
 * Batch embedding result
 */
export interface BatchEmbeddingResult {
	/** ID from input */
	id: string;
	/** Embedding result or error */
	result: EmbeddingResult | null;
	/** Error if embedding failed */
	error?: string;
}

/**
 * Embedding provider interface - swappable implementation
 */
export interface EmbeddingProvider {
	/** Provider name for logging */
	readonly name: string;

	/** Model identifier */
	readonly model: string;

	/** Vector dimensions */
	readonly dimensions: number;

	/**
	 * Generate embedding for a single text
	 */
	embed(text: string): Promise<EmbeddingResult>;

	/**
	 * Generate embeddings for multiple texts (batch)
	 */
	embedBatch(inputs: EmbeddingInput[]): Promise<BatchEmbeddingResult[]>;

	/**
	 * Check if provider is healthy/available
	 */
	healthCheck(): Promise<boolean>;
}

export const EMBEDDING_PROVIDER = "EMBEDDING_PROVIDER";
