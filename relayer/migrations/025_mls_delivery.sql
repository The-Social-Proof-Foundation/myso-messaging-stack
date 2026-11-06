-- MLS delivery service (E2EE M4). The relayer stores and orders MLS messages; it never holds keys.
-- KeyPackages: single-use join material uploaded by each device (wallet-certified credentials).
CREATE TABLE IF NOT EXISTS mls_key_packages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet TEXT NOT NULL,
    device_id TEXT NOT NULL,
    key_package BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_mls_key_packages_unclaimed
    ON mls_key_packages (wallet, device_id, created_at)
    WHERE claimed_at IS NULL;
-- Accepted epoch per group: exactly one commit may move each epoch forward.
CREATE TABLE IF NOT EXISTS mls_group_epochs (
    group_id TEXT PRIMARY KEY,
    epoch BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Welcomes addressed to one device each; deleted when fetched.
CREATE TABLE IF NOT EXISTS mls_welcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id TEXT NOT NULL,
    wallet TEXT NOT NULL,
    device_id TEXT NOT NULL,
    welcome BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mls_welcomes_device ON mls_welcomes (wallet, device_id);
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (
    kind IN ('text', 'system', 'post', 'request_payment', 'poll', 'token_transfer', 'message', 'event', 'commit')
);
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_kind_system_consistency;
ALTER TABLE messages ADD CONSTRAINT messages_kind_system_consistency CHECK (
    (
        kind IN ('text', 'post', 'request_payment', 'poll', 'token_transfer', 'message', 'event', 'commit')
        AND system_type IS NULL
    )
    OR (kind = 'system' AND system_type IS NOT NULL AND metadata IS NOT NULL)
);
