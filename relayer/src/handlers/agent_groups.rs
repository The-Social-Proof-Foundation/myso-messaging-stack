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
    pub organization_id: Option<String>,
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

#[derive(Debug, Serialize)]
pub struct MemberConversationsResponse {
    /// Group IDs from the relayer's membership event index. Callers must still
    /// check current on-chain permission before disclosing room data.
    pub group_ids: Vec<String>,
}

fn clamp_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(100).clamp(1, 500)
}

fn clamp_offset(offset: Option<i64>) -> usize {
    offset.unwrap_or(0).clamp(0, i64::MAX) as usize
}

#[derive(Debug, Deserialize)]
pub struct ListMemberConversationsQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub after_group_id: Option<String>,
}

/// Lists groups in which the authenticated wallet has any indexed permission.
/// The membership index is only a discovery hint; consumers must check current
/// chain permissions before reading or decrypting room contents.
pub async fn list_member_conversations(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Query(query): Query<ListMemberConversationsQuery>,
) -> Result<Json<MemberConversationsResponse>, ApiError> {
    let cursor = if let Some(raw) = query.after_group_id.as_deref() {
        let hex = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")).unwrap_or(raw);
        if hex.is_empty() || hex.len() > 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ApiError::BadRequest("after_group_id must be a MySo room object ID".into()));
        }
        Some(format!("0x{:0>64}", hex.to_ascii_lowercase()))
    } else {
        None
    };
    if cursor.is_some() && query.offset.unwrap_or(0) != 0 {
        return Err(ApiError::BadRequest("Use either after_group_id or offset, not both".into()));
    }
    let mut group_ids = state.membership_store.groups_for_member(&auth.sender_address);
    group_ids.sort();
    group_ids.dedup();
    let limit = clamp_limit(query.limit) as usize;
    let group_ids = if let Some(cursor) = cursor {
        group_ids.into_iter().filter(|group_id| {
            let hex = group_id.strip_prefix("0x").or_else(|| group_id.strip_prefix("0X")).unwrap_or(group_id);
            let normalized = format!("0x{:0>64}", hex.to_ascii_lowercase());
            normalized > cursor
        }).take(limit).collect()
    } else {
        let offset = clamp_offset(query.offset);
        group_ids.into_iter().skip(offset).take(limit).collect()
    };
    Ok(Json(MemberConversationsResponse { group_ids }))
}

fn to_wire(group: AgentMessagingGroup) -> AgentConversationWire {
    AgentConversationWire {
        group_id: group.group_id,
        creator_actor: group.creator_actor,
        creator_principal: group.creator_principal,
        creator_sub_agent_id: group.creator_sub_agent_id,
        creator_identity_class: group.creator_identity_class,
        organization_id: group.organization_id,
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
