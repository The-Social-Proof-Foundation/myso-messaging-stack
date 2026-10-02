-- Metadata-only conversation reports.
-- Columns are reporter, chat, optional peer wallet, reason, optional note, and time.
-- Do not add message plaintext or ciphertext columns to this table.

CREATE TABLE IF NOT EXISTS conversation_reports (
    id UUID PRIMARY KEY,
    reporter TEXT NOT NULL,
    group_id TEXT NOT NULL,
    reported_wallet TEXT,
    reason TEXT NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_reports_group_created
    ON conversation_reports (group_id, created_at DESC);
