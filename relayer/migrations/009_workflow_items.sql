-- Workflow inbox items (separate from chat messages).
-- item_type v1: approval_request, alert. status: open | actioned | dismissed | expired.

CREATE TABLE IF NOT EXISTS workflow_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT NOT NULL UNIQUE,
    recipient_address TEXT NOT NULL,
    item_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    title TEXT NOT NULL,
    body TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    organization_id TEXT,
    account_id TEXT,
    source_service TEXT NOT NULL,
    action_deadline_ms BIGINT,
    conversation_ref TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actioned_by TEXT,
    actioned_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workflow_items_recipient_status_created
    ON workflow_items (recipient_address, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_items_idempotency
    ON workflow_items (idempotency_key);
