//! GET/PUT `/v1/users/read-state` — opaque encrypted blob per wallet.
//! `timestamp` is validated by wallet auth middleware, not this handler DTO.
//!
//! Versioning: the server assigns `blob_version` (monotonic increment per
//! write). Clients may send `expected_version` (the version from their last
//! GET/PUT) to get compare-and-set semantics — a mismatch returns `409` with
//! code `READ_STATE_CONFLICT` and the current record, so the client can merge
//! and retry without another GET. Omitting `expected_version` preserves the
//! legacy last-writer-wins behavior.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::AuthContext;
use crate::handlers::messages::error::ApiError;
use crate::models::EncryptedBlobRecord;
use crate::services::realtime::UserFeedEvent;
use crate::state::AppState;
use crate::storage::PutUserReadStateResult;

#[derive(Debug, Deserialize)]
pub struct PutReadStateBody {
    pub sender_address: String,
    pub encrypted_blob: String,
    /// Legacy client-proposed version — accepted for backward compatibility
    /// but ignored (the server assigns versions).
    #[serde(default)]
    #[allow(dead_code)]
    pub blob_version: Option<u64>,
    /// When set, the write only succeeds if it matches the stored version.
    #[serde(default)]
    pub expected_version: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct ReadStateResponse {
    pub encrypted_blob: String,
    pub blob_version: u64,
    pub updated_at: String,
}

impl From<&EncryptedBlobRecord> for ReadStateResponse {
    fn from(record: &EncryptedBlobRecord) -> Self {
        Self {
            encrypted_blob: hex::encode(&record.encrypted_blob),
            blob_version: record.blob_version,
            updated_at: record.updated_at.to_rfc3339(),
        }
    }
}

pub async fn get_read_state(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<ReadStateResponse>, ApiError> {
    let record = state
        .storage
        .get_user_read_state(&auth.sender_address)
        .await
        .map_err(ApiError::from)?
        .ok_or_else(|| ApiError::NotFound("Read state not found".to_string()))?;

    Ok(Json(ReadStateResponse::from(&record)))
}

pub async fn put_read_state(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PutReadStateBody>,
) -> Result<Response, ApiError> {
    if body.sender_address != auth.sender_address {
        return Err(ApiError::Forbidden(
            "sender_address does not match authenticated wallet".to_string(),
        ));
    }

    let encrypted_blob = hex::decode(&body.encrypted_blob).map_err(|e| {
        ApiError::BadRequest(format!("Invalid hex in encrypted_blob: {}", e))
    })?;

    let result = state
        .storage
        .put_user_read_state(&auth.sender_address, encrypted_blob, body.expected_version)
        .await
        .map_err(ApiError::from)?;

    match result {
        PutUserReadStateResult::Stored { blob_version } => {
            // Postgres storage fans out via pg_notify; inline covers in-memory.
            if state.realtime_enabled && state.inline_realtime_publish {
                state
                    .realtime_hub
                    .publish_user_event(UserFeedEvent::ReadStateUpdated {
                        wallet: auth.sender_address.clone(),
                        blob_version,
                    });
            }
            Ok(Json(serde_json::json!({ "ok": true, "blob_version": blob_version }))
                .into_response())
        }
        PutUserReadStateResult::Conflict { current } => Ok((
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "Read state was modified by another client",
                "code": "READ_STATE_CONFLICT",
                "current": ReadStateResponse::from(&current),
            })),
        )
            .into_response()),
    }
}
