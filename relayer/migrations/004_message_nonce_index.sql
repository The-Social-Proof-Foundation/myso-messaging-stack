-- Prevent duplicate message nonces per group (replay protection)
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_group_nonce ON messages (group_id, nonce);
