-- Lattice Chunk Versioning Migration
-- Version: 002
-- Description: Add versioning columns to email_chunk for idempotency

-- Add chunking and normalization version columns
ALTER TABLE email_chunk
ADD COLUMN IF NOT EXISTS chunking_version VARCHAR(20) NOT NULL DEFAULT 'v1',
ADD COLUMN IF NOT EXISTS normalization_version VARCHAR(20) NOT NULL DEFAULT 'v1';

-- Update unique constraint to include versioning
-- First drop the old constraint if it exists
ALTER TABLE email_chunk DROP CONSTRAINT IF EXISTS uq_chunk_hash_version;

-- Create new unique constraint on email_id + chunk_hash + chunking_version + normalization_version
-- This ensures idempotency: same email + same algorithm versions = same chunks
ALTER TABLE email_chunk
ADD CONSTRAINT uq_chunk_email_versions
UNIQUE (email_id, chunk_hash, chunking_version, normalization_version);

-- Add index for version-based lookups
CREATE INDEX IF NOT EXISTS idx_chunk_versions
ON email_chunk(email_id, chunking_version, normalization_version);

-- Add comment
COMMENT ON COLUMN email_chunk.chunking_version IS 'Version of chunking algorithm (e.g., v1, v2)';
COMMENT ON COLUMN email_chunk.normalization_version IS 'Version of text normalization (e.g., v1, v2)';
