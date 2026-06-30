//! Agent-associated messaging group indexed from permissioned-group events.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMessagingGroup {
    pub group_id: String,
    pub creator_actor: String,
    pub creator_principal: String,
    pub creator_sub_agent_id: Option<String>,
    pub creator_identity_class: Option<i16>,
    pub group_name: Option<String>,
    pub group_uuid: Option<String>,
    pub created_at: DateTime<Utc>,
}
