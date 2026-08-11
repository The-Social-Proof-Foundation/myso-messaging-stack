//! Notification device keys, wallet prefs, group key listing.

use axum::extract::{Path, State};
use axum::Extension;
use axum::Json;
use chrono::Utc;
use serde::Deserialize;

use crate::auth::AuthContext;
use crate::handlers::messages::error::ApiError;
use crate::services::notification_push_store::{
    DeviceNotificationKeyRecord, WalletNotificationMode,
};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct PutNotificationKeyBody {
    pub sender_address: String,
    pub device_id: String,
    pub public_key: String,
    pub platform: String,
}

#[derive(Debug, Deserialize)]
pub struct PutNotificationPrefsBody {
    pub sender_address: String,
    pub notification_mode: String,
}

pub async fn put_notification_key(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PutNotificationKeyBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if body.sender_address != auth.sender_address {
        return Err(ApiError::Forbidden(
            "sender_address does not match authenticated wallet".to_string(),
        ));
    }
    if body.device_id.trim().is_empty() || body.public_key.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "device_id and public_key are required".to_string(),
        ));
    }

    state.notification_push.upsert_device_key(DeviceNotificationKeyRecord {
        wallet: auth.sender_address.clone(),
        device_id: body.device_id.trim().to_string(),
        public_key: body.public_key.trim().to_string(),
        platform: body.platform.to_ascii_lowercase(),
        updated_at: Utc::now(),
    });

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn get_notification_prefs(
    Extension(auth): Extension<AuthContext>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mode = state
        .notification_push
        .get_wallet_mode(&auth.sender_address);
    Ok(Json(serde_json::json!({
        "notification_mode": mode.as_str()
    })))
}

pub async fn put_notification_prefs(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PutNotificationPrefsBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if body.sender_address != auth.sender_address {
        return Err(ApiError::Forbidden(
            "sender_address does not match authenticated wallet".to_string(),
        ));
    }
    let mode = WalletNotificationMode::parse(&body.notification_mode).ok_or_else(|| {
        ApiError::BadRequest(
            "notification_mode must be all, badge_only, or none".to_string(),
        )
    })?;
    state
        .notification_push
        .set_wallet_mode(&auth.sender_address, mode);
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn get_group_notification_keys(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(group_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let members = state
        .membership_store
        .list_member_addresses(&group_id);
    let keys = state
        .notification_push
        .list_device_keys_for_wallets(&members)
        .into_iter()
        .filter(|k| k.wallet != auth.sender_address)
        .map(|k| {
            serde_json::json!({
                "device_id": k.device_id,
                "wallet": k.wallet,
                "public_key": k.public_key,
                "platform": k.platform,
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(serde_json::json!({ "items": keys })))
}
