-- Email Embedding Table
-- Version: 011
-- Description: Stores vector embeddings for email chunks

CREATE TABLE email_embedding (
    embedding_id UUID PRIMARY KEY,
    email_id UUID NOT NULL REFERENCES email(id) ON DELETE CASCADE,
    chunk_id UUID NOT NULL,
    chunk_hash VARCHAR(64) NOT NULL,
    embedding_model VARCHAR(100) NOT NULL,
    embedding_version VARCHAR(50) NOT NULL,
    vector_dim INTEGER NOT NULL,
    vector_data BYTEA NOT NULL,
    embedded_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_embedding_version UNIQUE (email_id, chunk_hash, embedding_version)
);

CREATE INDEX idx_embedding_email_id ON email_embedding(email_id);
CREATE INDEX idx_embedding_chunk_id ON email_embedding(chunk_id);
CREATE INDEX idx_embedding_version ON email_embedding(embedding_version);
