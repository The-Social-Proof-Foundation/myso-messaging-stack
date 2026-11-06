-- Wallet-signed notification key certificates.
-- Senders seal plaintext push previews to these device keys, so a key the relayer could
-- substitute would let it read previews. The certificate is the owning wallet's signature
-- over (wallet, device_id, public_key, platform, issued_at_ms); senders verify it before
-- encrypting. NULL = legacy unsigned key (senders skip it and push "New message").
ALTER TABLE device_notification_keys
    ADD COLUMN IF NOT EXISTS cert_version SMALLINT NULL,
    ADD COLUMN IF NOT EXISTS cert_issued_at_ms BIGINT NULL,
    ADD COLUMN IF NOT EXISTS cert_signature TEXT NULL,
    ADD COLUMN IF NOT EXISTS cert_public_key TEXT NULL;
