DELETE FROM push_tokens p
USING push_tokens newer
WHERE p.token = newer.token
  AND p.wallet <> newer.wallet
  AND (p.updated_at, p.wallet) < (newer.updated_at, newer.wallet);

CREATE INDEX IF NOT EXISTS idx_push_tokens_token ON push_tokens (token);
CREATE INDEX IF NOT EXISTS idx_push_tokens_wallet_device ON push_tokens (wallet, device_id);
