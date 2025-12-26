-- Lattice Initial Schema
-- Version: 001
-- Description: Core email and chunk tables with FTS support

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- Create enum types
CREATE TYPE deletion_status AS ENUM ('active', 'soft_deleted', 'hard_deleted');
CREATE TYPE extraction_status AS ENUM ('pending', 'success', 'failed', 'unsupported');

-- ============================================================================
-- Email table - System of Record for emails
-- ============================================================================
CREATE TABLE email (
    -- Primary key
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- External identifiers (deterministic for idempotency)
    tenant_id VARCHAR(255) NOT NULL,
    account_id VARCHAR(255) NOT NULL,
    provider_message_id VARCHAR(255) NOT NULL,
    thread_id VARCHAR(255),

    -- Content hash for deduplication
    content_hash VARCHAR(64) NOT NULL,

    -- Email metadata
    subject TEXT,
    from_address JSONB NOT NULL,  -- {name, address}
    to_addresses JSONB DEFAULT '[]'::jsonb,
    cc_addresses JSONB DEFAULT '[]'::jsonb,
    bcc_addresses JSONB DEFAULT '[]'::jsonb,

    -- Timestamps
    sent_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL,  -- Gmail internal_date
    fetched_at TIMESTAMPTZ NOT NULL,
    parsed_at TIMESTAMPTZ,
    indexed_at TIMESTAMPTZ,

    -- Storage references
    raw_object_uri TEXT,
    size_bytes INTEGER,

    -- Body content
    text_body TEXT,
    html_body TEXT,
    text_normalized TEXT,  -- Cleaned text for FTS

    -- Full-text search vector
    fts_vector TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('english', COALESCE(subject, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(text_normalized, '')), 'B')
    ) STORED,

    -- Lifecycle
    deletion_status deletion_status NOT NULL DEFAULT 'active',
    deleted_at TIMESTAMPTZ,
    deleted_reason VARCHAR(50),

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT uq_email_provider_account UNIQUE (account_id, provider_message_id)
);

-- Indexes for email table
CREATE INDEX idx_email_tenant_account ON email(tenant_id, account_id);
CREATE INDEX idx_email_account_id ON email(account_id);
CREATE INDEX idx_email_provider_message_id ON email(provider_message_id);
CREATE INDEX idx_email_thread_id ON email(thread_id);
CREATE INDEX idx_email_content_hash ON email(content_hash);
CREATE INDEX idx_email_received_at ON email(received_at DESC);
CREATE INDEX idx_email_deletion_status ON email(deletion_status) WHERE deletion_status = 'active';
CREATE INDEX idx_email_fts ON email USING GIN(fts_vector);

-- ============================================================================
-- Attachment table
-- ============================================================================
CREATE TABLE email_attachment (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email_id UUID NOT NULL REFERENCES email(id) ON DELETE CASCADE,

    -- Identifiers
    attachment_id UUID NOT NULL,  -- Lattice-assigned
    content_hash VARCHAR(64) NOT NULL,

    -- Metadata
    filename TEXT NOT NULL,
    mime_type VARCHAR(255) NOT NULL,
    size_bytes INTEGER NOT NULL,

    -- Storage
    storage_uri TEXT,

    -- Text extraction
    extracted_text TEXT,
    extraction_status extraction_status NOT NULL DEFAULT 'pending',
    extraction_error TEXT,
    extracted_at TIMESTAMPTZ,

    -- FTS for attachment text
    fts_vector TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('english', COALESCE(extracted_text, ''))
    ) STORED,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_attachment_email_id UNIQUE (email_id, attachment_id)
);

-- Indexes for attachment table
CREATE INDEX idx_attachment_email_id ON email_attachment(email_id);
CREATE INDEX idx_attachment_content_hash ON email_attachment(content_hash);
CREATE INDEX idx_attachment_extraction_status ON email_attachment(extraction_status);
CREATE INDEX idx_attachment_fts ON email_attachment USING GIN(fts_vector);

-- ============================================================================
-- Email chunk table
-- ============================================================================
CREATE TABLE email_chunk (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email_id UUID NOT NULL REFERENCES email(id) ON DELETE CASCADE,
    attachment_id UUID,  -- NULL if from body

    -- Chunk identifiers (deterministic)
    chunk_id UUID NOT NULL,
    chunk_hash VARCHAR(64) NOT NULL,

    -- Position
    chunk_index INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,

    -- Content
    chunk_text TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    token_count_estimate INTEGER,

    -- Classification
    source_type VARCHAR(20) NOT NULL,  -- body, attachment, subject
    section_type VARCHAR(30),  -- header, greeting, body, signature, quote

    -- Embedding tracking
    embedding_version VARCHAR(50),
    embedding_model VARCHAR(100),
    vector_id VARCHAR(255),  -- Milvus vector ID
    embedded_at TIMESTAMPTZ,
    upserted_at TIMESTAMPTZ,

    -- FTS for chunk text
    fts_vector TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('english', chunk_text)
    ) STORED,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_chunk_id UNIQUE (chunk_id),
    CONSTRAINT uq_chunk_hash_version UNIQUE (chunk_hash, embedding_version)
);

-- Indexes for chunk table
CREATE INDEX idx_chunk_email_id ON email_chunk(email_id);
CREATE INDEX idx_chunk_attachment_id ON email_chunk(attachment_id) WHERE attachment_id IS NOT NULL;
CREATE INDEX idx_chunk_hash ON email_chunk(chunk_hash);
CREATE INDEX idx_chunk_embedding_version ON email_chunk(embedding_version);
CREATE INDEX idx_chunk_vector_id ON email_chunk(vector_id) WHERE vector_id IS NOT NULL;
CREATE INDEX idx_chunk_source_type ON email_chunk(source_type);
CREATE INDEX idx_chunk_fts ON email_chunk USING GIN(fts_vector);

-- ============================================================================
-- Audit log table
-- ============================================================================
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Event info
    audit_id UUID NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    entity_type VARCHAR(30) NOT NULL,
    entity_id VARCHAR(255),

    -- Related entities
    email_id UUID REFERENCES email(id) ON DELETE SET NULL,
    provider_message_id VARCHAR(255),
    account_id VARCHAR(255),

    -- Action and outcome
    action VARCHAR(20) NOT NULL,
    outcome VARCHAR(20) NOT NULL,

    -- Details
    details JSONB,
    metrics JSONB,

    -- Correlation
    trace_id VARCHAR(64),
    span_id VARCHAR(32),
    dag_run_id VARCHAR(255),

    -- Actor
    service_name VARCHAR(100) NOT NULL,
    service_version VARCHAR(50),

    -- Timestamps
    event_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for audit log
CREATE INDEX idx_audit_event_type ON audit_log(event_type);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_email_id ON audit_log(email_id) WHERE email_id IS NOT NULL;
CREATE INDEX idx_audit_account_id ON audit_log(account_id);
CREATE INDEX idx_audit_event_at ON audit_log(event_at DESC);
CREATE INDEX idx_audit_trace_id ON audit_log(trace_id) WHERE trace_id IS NOT NULL;

-- ============================================================================
-- Sync state table (for incremental sync tracking)
-- ============================================================================
CREATE TABLE sync_state (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id VARCHAR(255) NOT NULL,
    account_id VARCHAR(255) NOT NULL,

    -- Gmail sync state
    history_id VARCHAR(50),
    last_sync_at TIMESTAMPTZ,
    last_message_count INTEGER DEFAULT 0,

    -- Sync status
    status VARCHAR(20) NOT NULL DEFAULT 'idle',  -- idle, syncing, failed
    error_message TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_sync_state_account UNIQUE (tenant_id, account_id)
);

CREATE INDEX idx_sync_state_status ON sync_state(status);

-- ============================================================================
-- Updated at trigger function
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to all tables with updated_at
CREATE TRIGGER update_email_updated_at
    BEFORE UPDATE ON email
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_attachment_updated_at
    BEFORE UPDATE ON email_attachment
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_chunk_updated_at
    BEFORE UPDATE ON email_chunk
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_sync_state_updated_at
    BEFORE UPDATE ON sync_state
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Comments for documentation
-- ============================================================================
COMMENT ON TABLE email IS 'System of record for emails. All email data flows through this table.';
COMMENT ON TABLE email_attachment IS 'Attachment metadata and extracted text.';
COMMENT ON TABLE email_chunk IS 'Text chunks for embedding. Links to Milvus vectors.';
COMMENT ON TABLE audit_log IS 'Audit trail for all pipeline events.';
COMMENT ON TABLE sync_state IS 'Gmail sync state for incremental syncs.';

COMMENT ON COLUMN email.content_hash IS 'SHA-256 of normalized content for deduplication';
COMMENT ON COLUMN email.fts_vector IS 'Full-text search vector (auto-generated)';
COMMENT ON COLUMN email_chunk.chunk_hash IS 'SHA-256 of chunk_text for deduplication';
COMMENT ON COLUMN email_chunk.vector_id IS 'Reference to vector in Milvus';
