-- Content envelope v2: opaque `message` / `event` row kinds and event push bookkeeping.
-- See docs/myso-messaging-stack/E2EE-Protocol-v2.md.
ALTER TABLE messages
    DROP CONSTRAINT IF EXISTS messages_kind_check;
ALTER TABLE messages
    ADD CONSTRAINT messages_kind_check CHECK (
        kind IN ('text', 'system', 'post', 'request_payment', 'poll', 'token_transfer', 'message', 'event')
    );
ALTER TABLE messages
    DROP CONSTRAINT IF EXISTS messages_kind_system_consistency;
ALTER TABLE messages
    ADD CONSTRAINT messages_kind_system_consistency CHECK (
        (
            kind IN ('text', 'post', 'request_payment', 'poll', 'token_transfer', 'message', 'event')
            AND system_type IS NULL
        )
        OR (kind = 'system' AND system_type IS NOT NULL AND metadata IS NOT NULL)
    );
-- Who an encrypted event was pushed to (sender-chosen `notify_wallets`). Backs v2 reaction
-- unread counts / inbox activity without the relayer knowing what the event was.
CREATE TABLE IF NOT EXISTS event_notifications (
    group_id TEXT NOT NULL,
    wallet TEXT NOT NULL,
    event_id UUID NOT NULL,
    event_order BIGINT NOT NULL,
    sender TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, wallet)
);
CREATE INDEX IF NOT EXISTS idx_event_notifications_group_wallet_created
    ON event_notifications (group_id, wallet, created_at DESC);
