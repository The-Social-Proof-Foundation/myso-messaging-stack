//! `/v1/groups/:group_id/attachments` — encrypted chat attachment blobs in R2.
//!
//! Clients encrypt with the group DEK before upload (AES-GCM, nonce kept in the message's
//! attachment row), so the relayer and R2 only ever hold ciphertext. Objects are scoped
//! per group: only an authorized member of `group_id` can upload or read them.
//! `storage_id` = `r2:<uuid>`; the object key is `attachments/<group_id>/<uuid>`.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Extension;
use axum::Json;
use serde::Deserialize;
use tracing::{info, warn};

use crate::auth::AuthContext;
use crate::handlers::messages::error::ApiError;
use crate::state::AppState;

/// Default per-file cap on encrypted bytes: photos are ~0.3–3 MB, a compressed 3-min 720p
/// clip fits under this. Override with `CHAT_ATTACHMENT_MAX_BYTES`; keep the iOS
/// `CHAT_ATTACHMENT_MAX_MB` at or below it.
pub const DEFAULT_MAX_ATTACHMENT_BYTES: usize = 50 * 1024 * 1024;

/// Per-file cap on encrypted bytes (`CHAT_ATTACHMENT_MAX_BYTES`, read once).
pub fn max_attachment_bytes() -> usize {
    static MAX: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *MAX.get_or_init(|| {
        std::env::var("CHAT_ATTACHMENT_MAX_BYTES")
            .ok()
            .and_then(|v| v.trim().parse::<usize>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_MAX_ATTACHMENT_BYTES)
    })
}

/// Request cap for the JSON + base64 envelope (~4/3 of the payload, plus fields).
pub fn max_attachment_request_bytes() -> usize {
    max_attachment_bytes() / 3 * 4 + 64 * 1024
}
pub const STORAGE_ID_PREFIX: &str = "r2:";

#[derive(Debug, Deserialize)]
struct UploadBody {
    /// Base64 (standard) of the client-encrypted attachment bytes.
    data: String,
}

fn object_key(group_id: &str, id: &uuid::Uuid) -> String {
    format!("attachments/{}/{}", group_id.to_ascii_lowercase(), id)
}

fn ensure_group(auth: &AuthContext, group_id: &str) -> Result<(), ApiError> {
    if auth.authorized_group.as_deref() != Some(group_id) {
        return Err(ApiError::Forbidden("Not authorized for this group".to_string()));
    }
    Ok(())
}

/// `POST` (body-signed): `{ group_id, sender_address, timestamp, data }` → `{ storage_id }`.
pub async fn upload_attachment(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Extension(auth): Extension<AuthContext>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    ensure_group(&auth, &group_id)?;
    let store = state
        .attachment_store
        .as_ref()
        .ok_or_else(|| ApiError::Internal("attachment storage is not configured".to_string()))?;
    let parsed: UploadBody = serde_json::from_slice(&body)
        .map_err(|e| ApiError::BadRequest(format!("invalid upload body: {e}")))?;
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, parsed.data.trim())
        .map_err(|_| ApiError::BadRequest("data must be base64".to_string()))?;
    if bytes.is_empty() {
        return Err(ApiError::BadRequest("attachment is empty".to_string()));
    }
    let max = max_attachment_bytes();
    if bytes.len() > max {
        return Err(ApiError::PayloadTooLarge(format!("attachment exceeds {max} bytes")));
    }
    let id = uuid::Uuid::new_v4();
    let size = bytes.len();
    store
        .put_object(&object_key(&group_id, &id), bytes)
        .await
        .map_err(|e| {
            warn!("attachment upload failed group={group_id}: {e}");
            ApiError::Internal("attachment upload failed".to_string())
        })?;
    info!("attachment stored group={group_id} id={id} bytes={size}");
    Ok(Json(serde_json::json!({ "storage_id": format!("{STORAGE_ID_PREFIX}{id}") })))
}

/// `GET` (group-header auth): ciphertext bytes for a member of the group.
pub async fn download_attachment(
    State(state): State<AppState>,
    Path((group_id, attachment_id)): Path<(String, String)>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Response, ApiError> {
    ensure_group(&auth, &group_id)?;
    let store = state
        .attachment_store
        .as_ref()
        .ok_or_else(|| ApiError::Internal("attachment storage is not configured".to_string()))?;
    let raw = attachment_id.strip_prefix(STORAGE_ID_PREFIX).unwrap_or(&attachment_id);
    // UUID only — never let a path segment pick another key.
    let id = uuid::Uuid::parse_str(raw)
        .map_err(|_| ApiError::BadRequest("invalid attachment id".to_string()))?;
    let bytes = store.get_object(&object_key(&group_id, &id)).await.map_err(|e| {
        warn!("attachment read failed group={group_id} id={id}: {e}");
        ApiError::NotFound("attachment not found".to_string())
    })?;
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            // Ciphertext is immutable per id; private so shared caches never keep it.
            (header::CACHE_CONTROL, "private, max-age=31536000, immutable"),
        ],
        bytes,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_keys_are_group_scoped_and_lowercase() {
        let id = uuid::Uuid::nil();
        assert_eq!(
            object_key("0xABC", &id),
            "attachments/0xabc/00000000-0000-0000-0000-000000000000"
        );
    }

    #[test]
    fn request_cap_covers_base64_of_max_payload() {
        assert!(max_attachment_request_bytes() > max_attachment_bytes() * 4 / 3);
    }
}
