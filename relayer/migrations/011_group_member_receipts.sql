-- Durable per-member delivery/read watermarks (replaces in-memory receipt mirror).
CREATE TABLE IF NOT EXISTS group_member_receipts (
    group_id TEXT NOT NULL,
    wallet TEXT NOT NULL,
    delivered_upto BIGINT NOT NULL DEFAULT 0,
    read_upto BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, wallet)
);

CREATE INDEX IF NOT EXISTS idx_group_member_receipts_group
    ON group_member_receipts (group_id);
