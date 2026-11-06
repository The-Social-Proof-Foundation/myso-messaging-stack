-- MLS multi-device (E2EE M5).
-- Latest signed GroupInfo per group: on-chain members fetch it to join by external commit.
CREATE TABLE IF NOT EXISTS mls_group_infos (
    group_id TEXT PRIMARY KEY,
    epoch BIGINT NOT NULL,
    group_info BYTEA NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Per-wallet self-group log (a wallet's own devices): carries history bundles between them.
CREATE TABLE IF NOT EXISTS mls_self_messages (
    wallet TEXT NOT NULL,
    seq BIGSERIAL,
    body BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (wallet, seq)
);
