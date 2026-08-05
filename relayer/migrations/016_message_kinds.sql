-- Client timeline kinds: post (share card), request_payment, poll (scaffolded).
-- Encrypted client payload like text; system rows unchanged.
ALTER TABLE messages
    DROP CONSTRAINT IF EXISTS messages_kind_check;
ALTER TABLE messages
    ADD CONSTRAINT messages_kind_check CHECK (
        kind IN ('text', 'system', 'post', 'request_payment', 'poll')
    );

ALTER TABLE messages
    DROP CONSTRAINT IF EXISTS messages_kind_system_consistency;
ALTER TABLE messages
    ADD CONSTRAINT messages_kind_system_consistency CHECK (
        (
            kind IN ('text', 'post', 'request_payment', 'poll')
            AND system_type IS NULL
        )
        OR (kind = 'system' AND system_type IS NOT NULL AND metadata IS NOT NULL)
    );
