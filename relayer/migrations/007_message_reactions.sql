-- Per-user message reactions. Replaces the aggregate `reaction_tallies` table
-- (tallies carried no user attribution, so existing rows cannot be migrated).
-- `emoji` is the canonical Unicode emoji string (NFC), which supports skin
-- tones, ZWJ sequences, and variation selectors without schema changes.
CREATE TABLE IF NOT EXISTS message_reactions (
    group_id TEXT NOT NULL,
    chain_seq BIGINT NOT NULL,
    emoji TEXT NOT NULL,
    member_address TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, chain_seq, emoji, member_address)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_group_seq
    ON message_reactions (group_id, chain_seq);

DROP TABLE IF EXISTS reaction_tallies;
