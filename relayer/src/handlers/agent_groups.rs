//! GET `/v1/agent-conversations` — wallet-authenticated agent group discovery.

use axum::extract::{Path, Query, State};
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::AuthContext;
use crate::handlers::messages::error::ApiError;
use crate::models::AgentMessagingGroup;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct ListAgentConversationsQuery {
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct AgentConversationWire {
    pub group_id: String,
    pub creator_actor: String,
    pub creator_principal: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator_sub_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator_identity_class: Option<i16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_uuid: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
pub struct AgentConversationsResponse {
    pub conversations: Vec<AgentConversationWire>,
}

fn clamp_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(100).clamp(1, 500)
}

fn to_wire(group: AgentMessagingGroup) -> AgentConversationWire {
    AgentConversationWire {
        group_id: group.group_id,
        creator_actor: group.creator_actor,
        creator_principal: group.creator_principal,
        creator_sub_agent_id: group.creator_sub_agent_id,
        creator_identity_class: group.creator_identity_class,
        group_name: group.group_name,
        group_uuid: group.group_uuid,
        created_at: group.created_at.timestamp(),
    }
}

pub async fn list_agent_conversations(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Query(query): Query<ListAgentConversationsQuery>,
) -> Result<Json<AgentConversationsResponse>, ApiError> {
    let limit = clamp_limit(query.limit);
    let rows = state
        .agent_group_store
        .list_by_principal(&auth.sender_address, limit)
        .await
        .map_err(ApiError::from)?;

    Ok(Json(AgentConversationsResponse {
        conversations: rows.into_iter().map(to_wire).collect(),
    }))
}

pub async fn list_groups_for_agent(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(derived_address): Path<String>,
    Query(query): Query<ListAgentConversationsQuery>,
) -> Result<Json<AgentConversationsResponse>, ApiError> {
    let limit = clamp_limit(query.limit);
    let rows = state
        .agent_group_store
        .list_by_creator_actor(&derived_address, limit)
        .await
        .map_err(ApiError::from)?;

    let sender = auth.sender_address.as_str();
    let filtered: Vec<_> = rows
        .into_iter()
        .filter(|row| row.creator_principal == sender || row.creator_actor == sender)
        .collect();

    Ok(Json(AgentConversationsResponse {
        conversations: filtered.into_iter().map(to_wire).collect(),
    }))
}
