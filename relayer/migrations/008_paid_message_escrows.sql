-- Paid DM escrow index synced from on-chain `message_log::PaidMessageSent` events.
-- Authoritative payment state for the paid-DM gate: a row proves the payer escrowed
-- MYSO to the recipient in this group (the contract already enforced the recipient's
-- minimum at open time). Upserted on (group_id, seq) so checkpoint replays are safe.
CREATE TABLE IF NOT EXISTS paid_message_escrows (
    group_id TEXT NOT NULL,
    seq BIGINT NOT NULL,
    payer TEXT NOT NULL,
    recipient TEXT NOT NULL,
    amount BIGINT NOT NULL,
    created_at_ms BIGINT NOT NULL,
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_paid_escrows_group_payer_recipient
    ON paid_message_escrows (group_id, payer, recipient);

-- First-outbound-message lookups for the paid-DM gate.
CREATE INDEX IF NOT EXISTS idx_messages_group_sender
    ON messages (group_id, sender_wallet_addr);

-- AgentGroupCreated organization context from on-chain events.
ALTER TABLE agent_messaging_groups
    ADD COLUMN IF NOT EXISTS organization_id TEXT;
