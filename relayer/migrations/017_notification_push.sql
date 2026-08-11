-- Device notification keys, opaque push envelopes, wallet push prefs
CREATE TABLE IF NOT EXISTS device_notification_keys (
    wallet TEXT NOT NULL,
    device_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'ios',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (wallet, device_id)
);

CREATE TABLE IF NOT EXISTS message_notification_envelopes (
    message_id UUID NOT NULL,
    device_id TEXT NOT NULL,
    encrypted_preview BYTEA NOT NULL,
    PRIMARY KEY (message_id, device_id)
);

CREATE TABLE IF NOT EXISTS wallet_notification_prefs (
    wallet TEXT PRIMARY KEY,
    notification_mode TEXT NOT NULL DEFAULT 'all',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
