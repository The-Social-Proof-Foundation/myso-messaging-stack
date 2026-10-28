-- Persist the canonical message signature format used for content and attachment binding.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS signature_version SMALLINT NOT NULL DEFAULT 1;
