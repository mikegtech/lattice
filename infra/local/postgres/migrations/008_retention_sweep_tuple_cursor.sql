-- Add tuple cursor support for stable pagination in retention sweep
-- UUID ordering is technically unsafe; (received_at, id) provides deterministic ordering

-- Add last_received_at column for tuple cursor
ALTER TABLE retention_sweep_run
    ADD COLUMN IF NOT EXISTS last_received_at TIMESTAMPTZ;

-- Update comment to reflect tuple cursor usage
COMMENT ON COLUMN retention_sweep_run.last_email_id IS 'Cursor component 2: last email ID processed (used with last_received_at for stable pagination)';
COMMENT ON COLUMN retention_sweep_run.last_received_at IS 'Cursor component 1: received_at of last email processed (used with last_email_id for stable pagination)';
