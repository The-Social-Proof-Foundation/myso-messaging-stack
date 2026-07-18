//! `GET /v1/archive/groups/:group_id/messages` — recover archived ciphertext.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct ArchiveMessagesQuery {
    pub namespace: Option<String>,
    pub after_order: Option<i64>,
    pub before_order: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveMessagesResponse {
    pub group_id: String,
    pub messages: Vec<Value>,
    pub has_next: bool,
}

/// List archived messages for a group (MessagingReader via auth middleware).
pub async fn get_archive_messages(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(query): Query<ArchiveMessagesQuery>,
) -> Result<Json<ArchiveMessagesResponse>, (StatusCode, Json<Value>)> {
    let Some(archive) = state.archive_read.as_ref() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "Archive recovery is not enabled (ARCHIVE_BACKEND=r2 required)"
            })),
        ));
    };

    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    match archive
        .list_messages(
            &group_id,
            query.namespace.as_deref(),
            query.after_order,
            query.before_order,
            limit,
        )
        .await
    {
        Ok((messages, has_next)) => Ok(Json(ArchiveMessagesResponse {
            group_id,
            messages,
            has_next,
        })),
        Err(e) => {
            tracing::error!("archive list failed: {e}");
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e.to_string() })),
            ))
        }
    }
}
