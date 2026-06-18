-- Messages, encrypted read-state, push tokens, presence
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY,
    group_id TEXT NOT NULL,
    order_num BIGINT,
    sender_wallet_addr TEXT NOT NULL,
    encrypted_msg BYTEA NOT NULL,
    nonce BYTEA NOT NULL,
    key_version BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    sync_status TEXT NOT NULL,
    quilt_patch_id TEXT,
    attachments JSONB NOT NULL DEFAULT '[]',
    signature BYTEA NOT NULL,
    public_key BYTEA NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_group_order ON messages (group_id, order_num);

CREATE TABLE IF NOT EXISTS user_read_states (
    wallet TEXT PRIMARY KEY,
    encrypted_blob BYTEA NOT NULL,
    blob_version BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS push_tokens (
    wallet TEXT NOT NULL,
    token TEXT NOT NULL,
    platform TEXT NOT NULL,
    environment TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (wallet, token)
);

CREATE TABLE IF NOT EXISTS presence (
    wallet TEXT PRIMARY KEY,
    last_seen_at TIMESTAMPTZ NOT NULL
);
