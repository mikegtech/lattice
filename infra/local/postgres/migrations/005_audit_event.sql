-- Audit event table for lifecycle traceability
-- Append-only store for all audit events

CREATE TABLE IF NOT EXISTS audit_event (
    id UUID PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL,
    tenant_id TEXT,
    account_id TEXT,
    alias TEXT,
    provider TEXT,
    event_type TEXT NOT NULL,
    stage TEXT,
    entity_type TEXT,
    entity_id TEXT,
    correlation_id TEXT,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for time-based queries (partitioning candidate)
CREATE INDEX IF NOT EXISTS idx_audit_event_occurred_at
    ON audit_event (occurred_at DESC);

-- Index for tenant/account queries
CREATE INDEX IF NOT EXISTS idx_audit_event_tenant_account
    ON audit_event (tenant_id, account_id)
    WHERE tenant_id IS NOT NULL;

-- Index for event type filtering
CREATE INDEX IF NOT EXISTS idx_audit_event_type
    ON audit_event (event_type);

-- Index for entity lookups (e.g., "show me all events for email X")
CREATE INDEX IF NOT EXISTS idx_audit_event_entity
    ON audit_event (entity_type, entity_id)
    WHERE entity_type IS NOT NULL AND entity_id IS NOT NULL;

-- Index for correlation/trace lookups
CREATE INDEX IF NOT EXISTS idx_audit_event_correlation
    ON audit_event (correlation_id)
    WHERE correlation_id IS NOT NULL;

-- Comment on table
COMMENT ON TABLE audit_event IS 'Append-only audit log for lifecycle traceability';
COMMENT ON COLUMN audit_event.id IS 'Deterministic UUID based on event content for idempotency';
COMMENT ON COLUMN audit_event.occurred_at IS 'When the event occurred (from event timestamp)';
COMMENT ON COLUMN audit_event.payload_json IS 'Sanitized event payload (no secrets/PII)';
