-- MLS devices' last activity (E2EE M6: "Devices" list). Touched when a device polls its Welcomes
-- or publishes KeyPackages; removed on logout. Only timestamps: which devices exist is read from
-- the wallet's MLS self-group on the client (end-to-end authenticated), not from this table.
CREATE TABLE IF NOT EXISTS mls_device_seen (
    wallet TEXT NOT NULL,
    device_id TEXT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (wallet, device_id)
);
