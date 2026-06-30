CREATE TABLE IF NOT EXISTS agent_messaging_groups (
    group_id TEXT PRIMARY KEY,
    creator_actor TEXT NOT NULL,
    creator_principal TEXT NOT NULL,
    creator_sub_agent_id TEXT,
    creator_identity_class SMALLINT,
    group_name TEXT,
    group_uuid TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_messaging_groups_creator_principal
    ON agent_messaging_groups (creator_principal);

CREATE INDEX IF NOT EXISTS idx_agent_messaging_groups_creator_actor
    ON agent_messaging_groups (creator_actor);
