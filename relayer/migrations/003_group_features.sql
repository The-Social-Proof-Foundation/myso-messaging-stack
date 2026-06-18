-- Off-chain reaction tallies and pins (receipts remain in-memory only; deprecated API)
CREATE TABLE IF NOT EXISTS reaction_tallies (
    group_id TEXT NOT NULL,
    chain_seq BIGINT NOT NULL,
    emoji_code INT NOT NULL,
    count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, chain_seq, emoji_code)
);

CREATE TABLE IF NOT EXISTS group_pins (
    group_id TEXT NOT NULL,
    chain_seq BIGINT NOT NULL,
    PRIMARY KEY (group_id, chain_seq)
);
