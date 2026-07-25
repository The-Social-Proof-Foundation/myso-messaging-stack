-- Explicit edit flag. Do not infer from updated_at (File Storage mark_synced bumps it).
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS is_edited BOOLEAN NOT NULL DEFAULT FALSE;
