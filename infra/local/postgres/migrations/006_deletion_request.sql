-- Deletion request ledger table for idempotent deletion tracking
-- Used by mail-deleter worker to ensure deletions are not re-processed

CREATE TABLE IF NOT EXISTS deletion_request (
    id UUID PRIMARY KEY,
    requested_at TIMESTAMPTZ NOT NULL,
    tenant_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    request_type TEXT NOT NULL,
    request_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending',
    emails_deleted INTEGER DEFAULT 0,
    chunks_deleted INTEGER DEFAULT 0,
    embeddings_deleted INTEGER DEFAULT 0,
    vectors_deleted INTEGER DEFAULT 0,
    storage_deleted INTEGER DEFAULT 0,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for checking existing requests (idempotency)
CREATE INDEX IF NOT EXISTS idx_deletion_request_id
    ON deletion_request (id);

-- Index for tenant/account queries
CREATE INDEX IF NOT EXISTS idx_deletion_request_tenant_account
    ON deletion_request (tenant_id, account_id);

-- Index for status queries (find pending/in_progress)
CREATE INDEX IF NOT EXISTS idx_deletion_request_status
    ON deletion_request (status)
    WHERE status IN ('pending', 'in_progress');

-- Index for cleanup of old completed requests
CREATE INDEX IF NOT EXISTS idx_deletion_request_completed
    ON deletion_request (completed_at)
    WHERE status = 'completed';

-- Add soft delete column to email table if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'email' AND column_name = 'deleted_at'
    ) THEN
        ALTER TABLE email ADD COLUMN deleted_at TIMESTAMPTZ;
        CREATE INDEX idx_email_deleted_at ON email (deleted_at) WHERE deleted_at IS NOT NULL;
    END IF;
END $$;

-- Comments
COMMENT ON TABLE deletion_request IS 'Ledger for tracking deletion requests and ensuring idempotency';
COMMENT ON COLUMN deletion_request.id IS 'Unique deletion request ID (from Kafka message)';
COMMENT ON COLUMN deletion_request.status IS 'pending, in_progress, completed, failed';
COMMENT ON COLUMN deletion_request.request_json IS 'Full deletion request payload for audit';
