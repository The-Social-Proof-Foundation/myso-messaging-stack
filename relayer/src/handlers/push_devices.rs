//! Push device token registration.
//! `timestamp` is validated by wallet auth middleware, not this handler DTO.

use axum::extract::{Path, State};
use axum::Extension;
use axum::Json;
use chrono::Utc;
use serde::Deserialize;

use crate::auth::AuthContext;
use crate::handlers::messages::error::ApiError;
use crate::models::PushTokenRecord;
use crate::services::push::ApnsEnvironment;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct PostPushTokenBody {
    pub sender_address: String,
    pub platform: String,
    pub token: String,
    pub environment: String,
}

fn validate_push_token_body(body: &PostPushTokenBody) -> Result<(), ApiError> {
    let platform = body.platform.to_ascii_lowercase();
    if !matches!(platform.as_str(), "ios" | "android" | "fcm" | "web") {
        return Err(ApiError::BadRequest(
            "platform must be 'ios', 'android', 'fcm', or 'web'".to_string(),
        ));
    }

    if platform == "ios" {
        ApnsEnvironment::from_token_str(&body.environment).map_err(|err| {
            ApiError::BadRequest(err)
        })?;
    }

    let token = body.token.trim();
    if token.is_empty() {
        return Err(ApiError::BadRequest("token must not be empty".to_string()));
    }
    if token.len() < 32 || token.len() > 200 {
        return Err(ApiError::BadRequest(
            "token length must be between 32 and 200 characters".to_string(),
        ));
    }
    if !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::BadRequest(
            "token must contain only hexadecimal characters".to_string(),
        ));
    }

    Ok(())
}

pub async fn post_push_token(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PostPushTokenBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if body.sender_address != auth.sender_address {
        return Err(ApiError::Forbidden(
            "sender_address does not match authenticated wallet".to_string(),
        ));
    }

    validate_push_token_body(&body)?;

    let record = PushTokenRecord {
        wallet: auth.sender_address.clone(),
        platform: body.platform.to_ascii_lowercase(),
        token: body.token.trim().to_string(),
        environment: body.environment.trim().to_ascii_lowercase(),
        updated_at: Utc::now(),
    };

    state
        .storage
        .upsert_push_token(record)
        .await
        .map_err(ApiError::from)?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn delete_push_token(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state
        .storage
        .delete_push_token(&auth.sender_address, &token)
        .await
        .map_err(ApiError::from)?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_body() -> PostPushTokenBody {
        PostPushTokenBody {
            sender_address: "0xabc".to_string(),
            platform: "ios".to_string(),
            token: "a".repeat(64),
            environment: "sandbox".to_string(),
        }
    }

    #[test]
    fn accepts_valid_ios_token() {
        assert!(validate_push_token_body(&valid_body()).is_ok());
    }

    #[test]
    fn accepts_android_fcm_and_web_platforms() {
        for platform in ["android", "fcm", "web"] {
            let mut body = valid_body();
            body.platform = platform.to_string();
            assert!(
                validate_push_token_body(&body).is_ok(),
                "expected {platform} to be an accepted push platform"
            );
        }
    }

    #[test]
    fn rejects_unknown_platform() {
        let mut body = valid_body();
        body.platform = "windows".to_string();
        assert!(validate_push_token_body(&body).is_err());
    }

    #[test]
    fn rejects_invalid_environment() {
        let mut body = valid_body();
        body.environment = "staging".to_string();
        assert!(validate_push_token_body(&body).is_err());
    }

    #[test]
    fn rejects_non_hex_token() {
        let mut body = valid_body();
        body.token = "z".repeat(64);
        assert!(validate_push_token_body(&body).is_err());
    }
}
