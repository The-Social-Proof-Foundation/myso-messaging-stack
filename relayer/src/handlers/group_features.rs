//! `/v1/groups/...` endpoints: off-chain mirrors for reactions, pins, and receipts.

use axum::extract::{Path, Query, State};
use axum::Extension;
use axum::Json;
use serde::Deserialize;

use crate::auth::AuthContext;
use crate::handlers::messages::error::ApiError;
use crate::models::{ReactionEntry, ReceiptStateResponse};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct ReactionsQuery {
    pub chain_seq: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct PostReactionBody {
    pub chain_seq: i64,
    pub emoji_code: u32,
    #[serde(default = "default_true")]
    pub add: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct PostPinBody {
    pub chain_seq: i64,
    #[serde(default = "default_true")]
    pub pin: bool,
}

#[derive(Debug, Deserialize)]
pub struct PostReceiptBody {
    #[serde(default)]
    pub delivered_upto: Option<u64>,
    #[serde(default)]
    pub read_upto: Option<u64>,
}

fn ensure_group(auth: &AuthContext, group_id: &str) -> Result<(), ApiError> {
    if auth.authorized_group.as_deref() != Some(group_id) {
        return Err(ApiError::Forbidden(
            "Not authorized for this group".to_string(),
        ));
    }
    Ok(())
}

pub async fn post_reaction(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PostReactionBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    ensure_group(&auth, &group_id)?;
    state
        .storage
        .replace_reaction_tally(&group_id, body.chain_seq, body.emoji_code, body.add)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn list_reactions(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Extension(auth): Extension<AuthContext>,
    Query(q): Query<ReactionsQuery>,
) -> Result<Json<Vec<ReactionEntry>>, ApiError> {
    ensure_group(&auth, &group_id)?;
    let rows = state
        .storage
        .list_reactions(&group_id, q.chain_seq)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(rows))
}

pub async fn set_pin(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PostPinBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    ensure_group(&auth, &group_id)?;
    state
        .storage
        .set_pin_for_seq(&group_id, body.chain_seq, body.pin)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn list_pins(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<Vec<i64>>, ApiError> {
    ensure_group(&auth, &group_id)?;
    let pins = state
        .storage
        .list_pins(&group_id)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(pins))
}

pub async fn post_receipts(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PostReceiptBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    ensure_group(&auth, &group_id)?;
    let member = auth.sender_address.as_str();
    if let Some(u) = body.delivered_upto {
        state
            .storage
            .update_receipt_delivered(&group_id, member, u)
            .await
            .map_err(ApiError::from)?;
    }
    if let Some(u) = body.read_upto {
        state
            .storage
            .update_receipt_read(&group_id, member, u)
            .await
            .map_err(ApiError::from)?;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn get_receipts(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<ReceiptStateResponse>, ApiError> {
    ensure_group(&auth, &group_id)?;
    let s = state
        .storage
        .get_receipt_state(&group_id, auth.sender_address.as_str())
        .await
        .map_err(ApiError::from)?;
    Ok(Json(s))
}
