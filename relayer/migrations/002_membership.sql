-- Group membership permissions (synced from on-chain Groups SDK events)
CREATE TABLE IF NOT EXISTS membership_permissions (
    group_id TEXT NOT NULL,
    address TEXT NOT NULL,
    permission TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (group_id, address, permission)
);
CREATE INDEX IF NOT EXISTS idx_membership_group ON membership_permissions (group_id);

CREATE TABLE IF NOT EXISTS membership_sync_state (
    id INT PRIMARY KEY DEFAULT 1,
    last_cursor BIGINT,
    updated_at TIMESTAMPTZ NOT NULL
);
