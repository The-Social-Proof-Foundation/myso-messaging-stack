//! GET/PUT `/v1/users/read-state` — opaque encrypted blob per wallet.
//! `timestamp` is validated by wallet auth middleware, not this handler DTO.

use axum::extract::State;
use axum::Extension;
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::auth::AuthContext;
use crate::handlers::messages::error::ApiError;
use crate::models::EncryptedBlobRecord;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct PutReadStateBody {
    pub sender_address: String,
    pub encrypted_blob: String,
    pub blob_version: u64,
}

#[derive(Debug, Serialize)]
pub struct ReadStateResponse {
    pub encrypted_blob: String,
    pub blob_version: u64,
    pub updated_at: String,
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

    Ok(Json(ReadStateResponse {
        encrypted_blob: hex::encode(&record.encrypted_blob),
        blob_version: record.blob_version,
        updated_at: record.updated_at.to_rfc3339(),
    }))
}

pub async fn put_read_state(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PutReadStateBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if body.sender_address != auth.sender_address {
        return Err(ApiError::Forbidden(
            "sender_address does not match authenticated wallet".to_string(),
        ));
    }

    let encrypted_blob = hex::decode(&body.encrypted_blob).map_err(|e| {
        ApiError::BadRequest(format!("Invalid hex in encrypted_blob: {}", e))
    })?;

    let record = EncryptedBlobRecord {
        encrypted_blob,
        blob_version: body.blob_version,
        updated_at: Utc::now(),
    };

    state
        .storage
        .put_user_read_state(&auth.sender_address, record)
        .await
        .map_err(ApiError::from)?;

    Ok(Json(serde_json::json!({ "ok": true })))
}
