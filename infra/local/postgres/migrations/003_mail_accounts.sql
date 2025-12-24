-- Lattice Mail Accounts Migration
-- Version: 003
-- Description: Add mail_accounts and mail_watermarks tables for multi-provider support

-- ============================================================================
-- Provider enum type
-- ============================================================================
CREATE TYPE mail_provider AS ENUM ('gmail', 'imap');

-- ============================================================================
-- Mail Accounts table
-- Stores configuration for mail accounts across providers
-- ============================================================================
CREATE TABLE mail_accounts (
    -- Primary key
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Tenant and account identifiers
    tenant_id TEXT NOT NULL,
    account_id TEXT NOT NULL,  -- Logical mailbox id, unique per tenant

    -- Provider configuration
    provider mail_provider NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,

    -- Provider-specific configuration (no secrets stored here)
    -- Gmail: {"email": "user@gmail.com", "scopes": ["INBOX"], "watch_labels": ["INBOX"]}
    -- IMAP: {"host": "imap.example.com", "port": 993, "folders": ["INBOX"]}
    config_json JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Data classification
    data_classification TEXT NOT NULL DEFAULT 'confidential',

    -- Audit timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT uq_mail_accounts_tenant_account UNIQUE (tenant_id, account_id),
    CONSTRAINT chk_mail_accounts_data_classification CHECK (
        data_classification IN ('public', 'internal', 'confidential', 'restricted')
    )
);

-- Indexes for mail_accounts
CREATE INDEX idx_mail_accounts_provider_enabled ON mail_accounts(provider, enabled);
CREATE INDEX idx_mail_accounts_tenant ON mail_accounts(tenant_id);

-- ============================================================================
-- Mail Watermarks table
-- Tracks sync progress per account/scope for incremental sync
-- ============================================================================
CREATE TABLE mail_watermarks (
    -- Primary key
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Account reference
    tenant_id TEXT NOT NULL,
    account_id TEXT NOT NULL,

    -- Scope identification
    provider mail_provider NOT NULL,
    scope TEXT NOT NULL,  -- Gmail: label/query scope, IMAP: folder name (e.g., "INBOX")

    -- Watermark state (provider-specific)
    -- Gmail: {"historyId": "12345678"}
    -- IMAP:  {"uidvalidity": 12345, "last_uid": 67890}
    watermark_json JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Audit timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT uq_mail_watermarks_account_scope UNIQUE (tenant_id, account_id, provider, scope),
    CONSTRAINT fk_mail_watermarks_account FOREIGN KEY (tenant_id, account_id)
        REFERENCES mail_accounts(tenant_id, account_id) ON DELETE CASCADE
);

-- Indexes for mail_watermarks
CREATE INDEX idx_mail_watermarks_provider_scope ON mail_watermarks(provider, scope);
CREATE INDEX idx_mail_watermarks_account ON mail_watermarks(tenant_id, account_id);

-- ============================================================================
-- Apply updated_at triggers
-- ============================================================================
CREATE TRIGGER update_mail_accounts_updated_at
    BEFORE UPDATE ON mail_accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_mail_watermarks_updated_at
    BEFORE UPDATE ON mail_watermarks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Comments for documentation
-- ============================================================================
COMMENT ON TABLE mail_accounts IS 'Mail account configuration for multi-provider ingestion. Stores tenant accounts for Gmail and IMAP providers.';
COMMENT ON TABLE mail_watermarks IS 'Sync watermarks for incremental mail ingestion. Tracks progress per account/scope.';

COMMENT ON COLUMN mail_accounts.account_id IS 'Logical mailbox identifier, unique per tenant (e.g., user email or custom ID)';
COMMENT ON COLUMN mail_accounts.config_json IS 'Provider-specific configuration. Gmail: {email, scopes, watch_labels}. IMAP: {host, port, folders}. No secrets.';
COMMENT ON COLUMN mail_watermarks.scope IS 'Gmail: label/query scope. IMAP: folder name (e.g., INBOX)';
COMMENT ON COLUMN mail_watermarks.watermark_json IS 'Provider-specific watermark. Gmail: {historyId}. IMAP: {uidvalidity, last_uid}';
