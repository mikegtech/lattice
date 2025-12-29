-- Lattice Drop Orphaned Chunk Constraint Migration
-- Version: 010
-- Description: Drop the orphaned uq_chunk_hash_version constraint that should have been removed in 002
--
-- Root Cause: Migration 002 used DROP CONSTRAINT IF EXISTS but the constraint still exists,
-- causing duplicate key violations when mail-upserter sets embedding_version on chunks
-- with the same chunk_hash.

-- Drop the orphaned constraint
ALTER TABLE email_chunk DROP CONSTRAINT IF EXISTS uq_chunk_hash_version;

-- Verify the correct constraint exists (from migration 002)
-- uq_chunk_email_versions: UNIQUE (email_id, chunk_hash, chunking_version, normalization_version)
