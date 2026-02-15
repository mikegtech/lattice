/**
 * Output payload for the es-upserter worker
 */
export interface EsUpsertPayload {
	provider_message_id: string;
	email_id: string;
	chunk_id: string;
	chunk_hash: string;
	embedding_id: string;
	embedding_version: string;
	es_index: string;
	es_doc_id: string;
	upserted_at: string;
	is_update: boolean;
}

/**
 * Elasticsearch document structure for email chunks
 */
export interface EsEmailChunkDocument {
	doc_id: string;
	tenant_id: string;
	account_id: string;
	alias: string;
	email_id: string;
	chunk_hash: string;
	embedding_version: string;
	embedding_model: string;
	section_type: string;
	email_timestamp: string | null;
	chunk_text: string;
	vector: number[];
	indexed_at: string;
}
