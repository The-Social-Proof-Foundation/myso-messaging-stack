-- Agent message attribution (cleartext audit metadata)
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS principal_owner TEXT NULL,
    ADD COLUMN IF NOT EXISTS sub_agent_id TEXT NULL,
    ADD COLUMN IF NOT EXISTS identity_class SMALLINT NULL,
    ADD COLUMN IF NOT EXISTS attribution_version SMALLINT NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_messages_principal_owner
    ON messages (principal_owner)
    WHERE principal_owner IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_sub_agent_id
    ON messages (sub_agent_id)
    WHERE sub_agent_id IS NOT NULL;
