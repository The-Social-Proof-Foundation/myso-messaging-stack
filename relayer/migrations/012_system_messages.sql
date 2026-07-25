-- First-class system messages in the shared timeline (kind=text|system).
-- System rows are cleartext structured events; ciphertext columns stay empty.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text',
    ADD COLUMN IF NOT EXISTS system_type TEXT NULL,
    ADD COLUMN IF NOT EXISTS metadata JSONB NULL,
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL;

ALTER TABLE messages
    DROP CONSTRAINT IF EXISTS messages_kind_check;
ALTER TABLE messages
    ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text', 'system'));

ALTER TABLE messages
    DROP CONSTRAINT IF EXISTS messages_system_type_check;
ALTER TABLE messages
    ADD CONSTRAINT messages_system_type_check CHECK (
        system_type IS NULL
        OR system_type IN ('member_joined', 'member_left', 'member_removed')
    );

ALTER TABLE messages
    DROP CONSTRAINT IF EXISTS messages_kind_system_consistency;
ALTER TABLE messages
    ADD CONSTRAINT messages_kind_system_consistency CHECK (
        (kind = 'text' AND system_type IS NULL)
        OR (kind = 'system' AND system_type IS NOT NULL AND metadata IS NOT NULL)
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency_key
    ON messages (idempotency_key)
    WHERE idempotency_key IS NOT NULL;
