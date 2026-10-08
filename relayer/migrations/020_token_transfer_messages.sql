-- 1:1 DM payments: `token_transfer` messages track an on-chain transfer by digest.
-- Encrypted client payload like text; relayer-owned cleartext status lives in `metadata`
-- (digest, asset_kind, status, optional request_message_id). `request_payment` rows also
-- keep relayer-owned status (open/rejected/paid/...) in `metadata`.
ALTER TABLE messages
    DROP CONSTRAINT IF EXISTS messages_kind_check;
ALTER TABLE messages
    ADD CONSTRAINT messages_kind_check CHECK (
        kind IN ('text', 'system', 'post', 'request_payment', 'poll', 'token_transfer')
    );

ALTER TABLE messages
    DROP CONSTRAINT IF EXISTS messages_kind_system_consistency;
ALTER TABLE messages
    ADD CONSTRAINT messages_kind_system_consistency CHECK (
        (
            kind IN ('text', 'post', 'request_payment', 'poll', 'token_transfer')
            AND system_type IS NULL
        )
        OR (kind = 'system' AND system_type IS NOT NULL AND metadata IS NOT NULL)
    );

-- Digest lookup for the confirmation service (checkpoint stream match).
CREATE INDEX IF NOT EXISTS idx_messages_token_transfer_digest
    ON messages ((metadata ->> 'digest'))
    WHERE kind = 'token_transfer';

-- Pending sweeper: unresolved transfers / open requests.
CREATE INDEX IF NOT EXISTS idx_messages_token_transfer_pending
    ON messages (created_at)
    WHERE kind = 'token_transfer' AND (metadata ->> 'status') = 'pending';
