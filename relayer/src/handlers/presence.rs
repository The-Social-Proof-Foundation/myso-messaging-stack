//! Client presence heartbeat for push gating.
//! `timestamp` is validated by wallet auth middleware, not this handler DTO.

use axum::extract::State;
use axum::Extension;
use axum::Json;
use serde::Deserialize;

use crate::auth::AuthContext;
use crate::handlers::messages::error::ApiError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct PostPresenceBody {
    pub sender_address: String,
    #[serde(default = "default_active")]
    pub active: bool,
}

fn default_active() -> bool {
    true
}

pub async fn post_presence(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PostPresenceBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if body.sender_address != auth.sender_address {
        return Err(ApiError::Forbidden(
            "sender_address does not match authenticated wallet".to_string(),
        ));
    }

    if body.active {
        state
            .storage
            .update_presence(&auth.sender_address)
            .await
            .map_err(ApiError::from)?;
    } else {
        // Explicit logout / teardown — drop sticky last_seen so GET snapshots
        // and push gating do not treat the wallet as recently active.
        state
            .storage
            .clear_presence(&auth.sender_address)
            .await
            .map_err(ApiError::from)?;
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}
