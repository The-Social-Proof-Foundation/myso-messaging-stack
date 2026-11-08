-- Push retry queue + dead-letter state. The first send still happens inline from the
-- message handler (fast path); only sends that fail retryably (APNs 5xx / 429 / timeout)
-- land here, and services::push::retry_queue re-sends them with exponential backoff.
-- `job` carries what the original send needed (already-sealed envelope, never plaintext).
-- Delivered rows are deleted; dead rows are kept briefly for inspection, then pruned.
CREATE TABLE IF NOT EXISTS push_retry_queue (
    id BIGSERIAL PRIMARY KEY,
    wallet TEXT NOT NULL,
    token JSONB NOT NULL,
    job JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'dead')),
    attempts INT NOT NULL DEFAULT 1,
    max_attempts INT NOT NULL DEFAULT 6,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    leased_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_retry_queue_due ON push_retry_queue (available_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_push_retry_queue_leased ON push_retry_queue (leased_at) WHERE status = 'leased';
CREATE INDEX IF NOT EXISTS idx_push_retry_queue_dead ON push_retry_queue (updated_at) WHERE status = 'dead';
