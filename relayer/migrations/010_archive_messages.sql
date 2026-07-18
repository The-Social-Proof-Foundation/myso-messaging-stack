-- Durable archive index for R2-backed message recovery (bodies live in R2).
CREATE TABLE IF NOT EXISTS archive_messages (
    namespace TEXT NOT NULL,
    group_id TEXT NOT NULL,
    message_id UUID NOT NULL,
    msg_order BIGINT,
    sync_status TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (namespace, group_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_archive_group_order
    ON archive_messages (namespace, group_id, msg_order);
