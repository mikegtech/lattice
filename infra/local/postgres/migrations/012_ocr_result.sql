-- OCR Result table for idempotency and tracking
-- Stores metadata about OCR processing, actual text stored in MinIO

CREATE TYPE ocr_processing_status AS ENUM ('processing', 'success', 'failed');

CREATE TABLE ocr_result (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id VARCHAR(255) NOT NULL UNIQUE,
    tenant_id VARCHAR(255) NOT NULL,
    source_service VARCHAR(255) NOT NULL,
    correlation_id VARCHAR(255) NOT NULL,

    -- Input tracking
    input_uri TEXT NOT NULL,
    input_mime_type VARCHAR(127) NOT NULL,
    input_size_bytes BIGINT,

    -- Processing status
    status ocr_processing_status NOT NULL DEFAULT 'processing',

    -- Result (text stored in MinIO, referenced by URI)
    text_uri TEXT,
    text_length INTEGER,
    page_count INTEGER,
    processing_time_ms INTEGER,
    confidence SMALLINT,  -- 0-100 scale

    -- Error tracking
    error_code VARCHAR(63),
    error_message TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    -- Indexes for common queries
    CONSTRAINT ocr_result_confidence_range CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100))
);

-- Index for idempotency lookups
CREATE INDEX idx_ocr_result_request_id ON ocr_result(request_id);

-- Index for querying by source service
CREATE INDEX idx_ocr_result_source ON ocr_result(source_service, correlation_id);

-- Index for tenant scoped queries
CREATE INDEX idx_ocr_result_tenant ON ocr_result(tenant_id, created_at DESC);

-- Index for status monitoring
CREATE INDEX idx_ocr_result_status ON ocr_result(status, created_at DESC);

COMMENT ON TABLE ocr_result IS 'Tracks OCR processing requests and results. Actual extracted text is stored in MinIO (claim-check pattern).';
COMMENT ON COLUMN ocr_result.request_id IS 'Unique request ID for idempotency - same request_id will not be reprocessed';
COMMENT ON COLUMN ocr_result.source_service IS 'Service that requested OCR (e.g., mail-extractor)';
COMMENT ON COLUMN ocr_result.correlation_id IS 'ID for correlating result back to source (e.g., email_id:attachment_id)';
COMMENT ON COLUMN ocr_result.text_uri IS 'S3/MinIO URI where extracted text is stored';
