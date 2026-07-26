-- Per-chat online presence visibility (default: show online).
-- Missing / false = peers may see Online; true = force offline in that group.

ALTER TABLE conversation_preferences
    ADD COLUMN IF NOT EXISTS hide_online_presence BOOLEAN NOT NULL DEFAULT false;
