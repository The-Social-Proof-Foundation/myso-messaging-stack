-- Inbox reaction activity (unread-counts): newest reactions per group by time.
CREATE INDEX IF NOT EXISTS idx_message_reactions_group_created
    ON message_reactions (group_id, created_at DESC);
