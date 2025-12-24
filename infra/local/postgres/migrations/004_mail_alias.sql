-- Lattice Mail Alias Migration
-- Version: 004
-- Description: Add alias column to mail_accounts for post-processing routing

-- ============================================================================
-- Add alias column to mail_accounts
-- ============================================================================
ALTER TABLE mail_accounts
    ADD COLUMN alias TEXT;

-- Set default alias based on account_id for existing rows
UPDATE mail_accounts
SET alias = account_id
WHERE alias IS NULL;

-- Make alias NOT NULL after populating
ALTER TABLE mail_accounts
    ALTER COLUMN alias SET NOT NULL;

-- Add unique constraint for tenant + alias (each alias must be unique per tenant)
ALTER TABLE mail_accounts
    ADD CONSTRAINT uq_mail_accounts_tenant_alias UNIQUE (tenant_id, alias);

-- ============================================================================
-- Add source_folder column to mail_accounts for IMAP
-- ============================================================================
-- This allows specifying which folder to read from (default INBOX)
-- Stored separately from config_json for queryability
ALTER TABLE mail_accounts
    ADD COLUMN source_folder TEXT DEFAULT 'INBOX';

-- ============================================================================
-- Comments for documentation
-- ============================================================================
COMMENT ON COLUMN mail_accounts.alias IS 'Stable logical label for processed destination. Used for Gmail label (Lattice/<alias>) and IMAP folder routing.';
COMMENT ON COLUMN mail_accounts.source_folder IS 'IMAP source folder to read from (default INBOX). Gmail ignores this field.';
