-- Per-member conversation preferences (server-visible; push + receipt enforcement).
-- Missing row = defaults (notification_mode=all, receipt_mode=full).

CREATE TABLE IF NOT EXISTS conversation_preferences (
    group_id TEXT NOT NULL,
    wallet TEXT NOT NULL,
    notification_mode TEXT NOT NULL DEFAULT 'all'
        CHECK (notification_mode IN ('all', 'none')),
    receipt_mode TEXT NOT NULL DEFAULT 'full'
        CHECK (receipt_mode IN ('full', 'delivered_only', 'none')),
    version INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, wallet)
);

CREATE INDEX IF NOT EXISTS idx_conversation_preferences_group
    ON conversation_preferences (group_id);
