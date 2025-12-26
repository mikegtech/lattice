-- Retention sweep run tracking table for idempotent sweep operations
-- Used by lattice__retention_sweep DAG to track sweep progress and enable resumability

CREATE TABLE IF NOT EXISTS retention_sweep_run (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Sweep parameters (used for idempotency)
    tenant_id TEXT NOT NULL,
    account_id TEXT,                -- NULL means all accounts in tenant
    alias TEXT,                     -- Optional alias filter
    cutoff_date TIMESTAMPTZ NOT NULL,

    -- Run status
    status TEXT NOT NULL DEFAULT 'running',  -- running, completed, failed

    -- Progress tracking
    last_email_id TEXT,             -- Cursor/checkpoint for resumability
    emails_targeted INTEGER NOT NULL DEFAULT 0,
    emails_published INTEGER NOT NULL DEFAULT 0,

    -- Error tracking
    last_error TEXT,

    -- Completion
    completed_at TIMESTAMPTZ
);

-- Unique constraint for idempotency: only one running sweep per tenant+cutoff
-- Allows reruns with same parameters if previous run completed
CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_sweep_run_unique_running
    ON retention_sweep_run (tenant_id, cutoff_date)
    WHERE status = 'running';

-- Index for finding existing sweeps
CREATE INDEX IF NOT EXISTS idx_retention_sweep_run_tenant_cutoff
    ON retention_sweep_run (tenant_id, cutoff_date, status);

-- Index for listing recent sweeps
CREATE INDEX IF NOT EXISTS idx_retention_sweep_run_created
    ON retention_sweep_run (created_at DESC);

-- Apply updated_at trigger
CREATE TRIGGER update_retention_sweep_run_updated_at
    BEFORE UPDATE ON retention_sweep_run
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE retention_sweep_run IS 'Tracks retention sweep DAG runs for idempotency and resumability';
COMMENT ON COLUMN retention_sweep_run.status IS 'running = in progress, completed = finished successfully, failed = stopped with error';
COMMENT ON COLUMN retention_sweep_run.last_email_id IS 'Checkpoint for resumable processing - last email ID processed';
COMMENT ON COLUMN retention_sweep_run.emails_targeted IS 'Total emails matching retention criteria';
COMMENT ON COLUMN retention_sweep_run.emails_published IS 'Number of deletion requests published to Kafka';
