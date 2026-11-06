-- E2EE M8: passkey-encrypted message history backup. Append-only, opaque segments: each is
-- AES-256-GCM ciphertext under a key derived from the owner's passkey PRF (the relayer never
-- has it), wrapping rows that are themselves still DEK-sealed (on-chain MyData gate).
-- `key_id` names which passkey-derived key a segment is under (not secret).
CREATE TABLE IF NOT EXISTS mls_backup_segments (
    wallet TEXT NOT NULL,
    key_id TEXT NOT NULL,
    seq BIGSERIAL,
    body BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (wallet, seq)
);
CREATE INDEX IF NOT EXISTS idx_mls_backup_segments_key ON mls_backup_segments (wallet, key_id, seq);
