//! Workflow inbox REST + internal ingest.

use axum::extract::{Path, Query, State};
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthContext;
use crate::handlers::messages::error::ApiError;
use crate::models::workflow_item::{
    is_allowed_workflow_item_type, WorkflowItem, WorkflowItemIngest, STATUS_ACTIONED,
    STATUS_DISMISSED, STATUS_OPEN,
};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct ListWorkflowQuery {
    pub status: Option<String>,
    #[serde(rename = "type")]
    pub item_type: Option<String>,
    pub cursor: Option<Uuid>,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    50
}

#[derive(Debug, Serialize)]
pub struct WorkflowItemWire {
    pub id: Uuid,
    pub idempotency_key: String,
    pub item_type: String,
    pub status: String,
    pub title: String,
    pub body: Option<String>,
    pub payload: serde_json::Value,
    pub organization_id: Option<String>,
    pub account_id: Option<String>,
    pub source_service: String,
    pub action_deadline_ms: Option<i64>,
    pub conversation_ref: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<WorkflowItem> for WorkflowItemWire {
    fn from(item: WorkflowItem) -> Self {
        Self {
            id: item.id,
            idempotency_key: item.idempotency_key,
            item_type: item.item_type,
            status: item.status,
            title: item.title,
            body: item.body,
            payload: item.payload,
            organization_id: item.organization_id,
            account_id: item.account_id,
            source_service: item.source_service,
            action_deadline_ms: item.action_deadline_ms,
            conversation_ref: item.conversation_ref,
            created_at: item.created_at.to_rfc3339(),
            updated_at: item.updated_at.to_rfc3339(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ListWorkflowResponse {
    pub items: Vec<WorkflowItemWire>,
}

#[derive(Debug, Serialize)]
pub struct WorkflowBadgeResponse {
    pub open_count: i64,
}

#[derive(Debug, Serialize)]
pub struct IngestWorkflowResponse {
    pub id: Uuid,
    pub status: String,
}

pub async fn list_workflow_items(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Query(query): Query<ListWorkflowQuery>,
) -> Result<Json<ListWorkflowResponse>, ApiError> {
    if !state.workflow_enabled {
        return Ok(Json(ListWorkflowResponse { items: vec![] }));
    }
    let limit = query.limit.clamp(1, 100);
    let rows = state
        .workflow_store
        .list_for_recipient(
            &auth.sender_address,
            query.status.as_deref(),
            query.item_type.as_deref(),
            query.cursor,
            limit,
        )
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Json(ListWorkflowResponse {
        items: rows.into_iter().map(WorkflowItemWire::from).collect(),
    }))
}

pub async fn workflow_badge(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<WorkflowBadgeResponse>, ApiError> {
    if !state.workflow_enabled {
        return Ok(Json(WorkflowBadgeResponse { open_count: 0 }));
    }
    let count = state
        .workflow_store
        .open_count(&auth.sender_address)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Json(WorkflowBadgeResponse { open_count: count }))
}

pub async fn ack_workflow_item(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<WorkflowItemWire>, ApiError> {
    let row = state
        .workflow_store
        .transition_status(id, &auth.sender_address, STATUS_ACTIONED, Some(&auth.sender_address))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .ok_or_else(|| ApiError::NotFound("workflow item not found".into()))?;
    Ok(Json(WorkflowItemWire::from(row)))
}

pub async fn dismiss_workflow_item(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<WorkflowItemWire>, ApiError> {
    let row = state
        .workflow_store
        .transition_status(id, &auth.sender_address, STATUS_DISMISSED, Some(&auth.sender_address))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .ok_or_else(|| ApiError::NotFound("workflow item not found".into()))?;
    Ok(Json(WorkflowItemWire::from(row)))
}

pub async fn ingest_workflow_item_internal(
    State(state): State<AppState>,
    Json(body): Json<WorkflowItemIngest>,
) -> Result<Json<IngestWorkflowResponse>, ApiError> {
    if !state.workflow_enabled {
        return Err(ApiError::Internal("workflow inbox disabled".into()));
    }
    if body.recipient_address.is_empty() || body.idempotency_key.is_empty() {
        return Err(ApiError::BadRequest(
            "recipient_address and idempotency_key required".into(),
        ));
    }
    if !is_allowed_workflow_item_type(&body.item_type) {
        return Err(ApiError::BadRequest(format!(
            "unsupported workflow item_type: {}",
            body.item_type
        )));
    }
    let row = state
        .workflow_store
        .upsert_ingest(&body)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    let push = state.push_service.clone();
    let storage = state.storage.clone();
    let recipient = row.recipient_address.clone();
    let item_type = row.item_type.clone();
    let item_id = row.id.to_string();
    tokio::spawn(async move {
        push
            .notify_workflow_item(&storage, &recipient, &item_type, &item_id)
            .await;
    });

    Ok(Json(IngestWorkflowResponse {
        id: row.id,
        status: STATUS_OPEN.to_string(),
    }))
}
