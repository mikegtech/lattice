-- Attachment Extraction Tracking
-- Version: 009
-- Description: Add columns for tracking extraction attempts and retry limiting

-- Add extraction tracking columns
ALTER TABLE email_attachment
ADD COLUMN IF NOT EXISTS extraction_attempts INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_extraction_attempt TIMESTAMPTZ;

-- Add index for pending extractions (used by extractor worker queries)
CREATE INDEX IF NOT EXISTS idx_attachment_pending_extraction
ON email_attachment(extraction_status)
WHERE extraction_status = 'pending';

-- Add partial index for failed extractions that may be retried
CREATE INDEX IF NOT EXISTS idx_attachment_failed_extraction
ON email_attachment(extraction_status, extraction_attempts)
WHERE extraction_status = 'failed' AND extraction_attempts < 3;

-- Comments for documentation
COMMENT ON COLUMN email_attachment.extraction_attempts IS 'Number of extraction attempts (for retry limiting)';
COMMENT ON COLUMN email_attachment.last_extraction_attempt IS 'Timestamp of last extraction attempt';
