-- Retention sweep run tracking table for idempotent sweep operations
-- Used by lattice__retention_sweep DAG to track sweep progress and enable resumability
--
-- Key design decisions:
-- 1. Cursor uses (received_at, id) tuple for stable pagination (UUID ordering unsafe)
-- 2. NULL-safe unique constraint on (tenant_id, cutoff_date, account_id, alias)
-- 3. Idempotent trigger creation

-- Ensure uuid-ossp extension is available (should exist from 001_initial_schema)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS retention_sweep_run (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Sweep parameters (used for idempotency)
    tenant_id TEXT NOT NULL,
    account_id TEXT,                    -- NULL means all accounts in tenant
    alias TEXT,                         -- Optional alias filter
    cutoff_date TIMESTAMPTZ NOT NULL,

    -- Run status
    status TEXT NOT NULL DEFAULT 'running',  -- running, completed, failed

    -- Progress tracking with tuple-based cursor
    -- Must use (received_at, id) for stable pagination since UUID ordering is unsafe
    last_received_at TIMESTAMPTZ,       -- Cursor component 1: last email's received_at
    last_email_id UUID,                 -- Cursor component 2: last email's id
    emails_targeted INTEGER NOT NULL DEFAULT 0,
    emails_published INTEGER NOT NULL DEFAULT 0,

    -- Error tracking
    last_error TEXT,

    -- Completion
    completed_at TIMESTAMPTZ
);

-- Unique constraint for idempotency: only one running sweep per parameter set
-- Uses COALESCE to normalize NULL values for account_id and alias
-- This prevents duplicate running sweeps for the same:
--   (tenant_id, cutoff_date, account_id, alias) combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_sweep_run_unique_running
    ON retention_sweep_run (
        tenant_id,
        cutoff_date,
        COALESCE(account_id, ''),
        COALESCE(alias, '')
    )
    WHERE status = 'running';

-- Index for finding existing sweeps by parameters
CREATE INDEX IF NOT EXISTS idx_retention_sweep_run_tenant_cutoff
    ON retention_sweep_run (tenant_id, cutoff_date, status);

-- Index for listing recent sweeps
CREATE INDEX IF NOT EXISTS idx_retention_sweep_run_created
    ON retention_sweep_run (created_at DESC);

-- Idempotent trigger creation using DO block
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'update_retention_sweep_run_updated_at'
    ) THEN
        CREATE TRIGGER update_retention_sweep_run_updated_at
            BEFORE UPDATE ON retention_sweep_run
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- Comments
COMMENT ON TABLE retention_sweep_run IS 'Tracks retention sweep DAG runs for idempotency and resumability';
COMMENT ON COLUMN retention_sweep_run.status IS 'running = in progress, completed = finished successfully, failed = stopped with error';
COMMENT ON COLUMN retention_sweep_run.last_received_at IS 'Cursor component 1: received_at of last email published (for tuple-based pagination)';
COMMENT ON COLUMN retention_sweep_run.last_email_id IS 'Cursor component 2: UUID of last email published (for tuple-based pagination)';
COMMENT ON COLUMN retention_sweep_run.emails_targeted IS 'Total emails selected in current batch';
COMMENT ON COLUMN retention_sweep_run.emails_published IS 'Cumulative number of deletion requests published to Kafka';
