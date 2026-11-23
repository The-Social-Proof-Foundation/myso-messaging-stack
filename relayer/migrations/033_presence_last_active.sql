-- Durable "last active" per wallet for last-seen labels. Unlike `presence` (push gating, cleared
-- the moment a wallet goes offline), this row is only ever moved forward.
CREATE TABLE IF NOT EXISTS presence_last_active (
    wallet TEXT PRIMARY KEY,
    last_active_at TIMESTAMPTZ NOT NULL
);
