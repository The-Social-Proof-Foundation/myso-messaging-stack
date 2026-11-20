//! Notification device keys, wallet prefs, group key listing.

use axum::extract::{Path, State};
use axum::Extension;
use axum::Json;
use chrono::Utc;
use serde::Deserialize;

use crate::auth::request_sender::{parse_request_key, verify_request_sender};
use crate::auth::signature::strip_hex_prefix;
use crate::auth::AuthContext;
use crate::handlers::messages::error::ApiError;
use crate::services::notification_push_store::{
    DeviceKeyCertificate, DeviceNotificationKeyRecord, WalletNotificationMode,
};
use crate::state::AppState;

/// Current notification key certificate version.
pub const KEY_CERTIFICATE_VERSION: i16 = 1;

/// A certificate may not claim to be issued further than this in the future (clock skew).
const KEY_CERTIFICATE_MAX_FUTURE_SKEW_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Deserialize)]
pub struct PutNotificationKeyBody {
    pub sender_address: String,
    pub device_id: String,
    pub public_key: String,
    pub platform: String,
    /// Wallet signature over the key (optional so old clients still register; senders
    /// skip keys without one).
    #[serde(default)]
    pub key_certificate: Option<KeyCertificateBody>,
    #[serde(default)]
    pub receipt_public_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct KeyCertificateBody {
    pub version: i16,
    pub issued_at_ms: i64,
    /// Hex, request-auth encoding (raw ed25519 signature, or full serialized zkLogin signature).
    pub signature: String,
    /// Hex flagged public key, request-auth encoding (`05` for zkLogin).
    pub public_key: String,
}

/// Bytes the owning wallet signs (as a personal message) to certify a notification key.
/// Senders rebuild this from the served fields and verify before sealing a preview to the key.
/// Must match iOS `DeviceNotificationKeyCertificate.canonical` byte-for-byte.
pub fn key_certificate_canonical(
    wallet: &str,
    device_id: &str,
    public_key_hex: &str,
    platform: &str,
    issued_at_ms: i64,
) -> String {
    format!(
        "myso-notification-key-v1:{}:{}:{}:{}:{}",
        wallet.trim().to_ascii_lowercase(),
        device_id.trim(),
        strip_hex_prefix(public_key_hex.trim()).to_ascii_lowercase(),
        platform.trim().to_ascii_lowercase(),
        issued_at_ms
    )
}

/// Verifies `cert` is the wallet's own signature over this exact key. The relayer checks this
/// so it never serves a broken certificate; senders still verify independently, since the
/// whole point is not having to trust the relayer.
async fn verify_key_certificate(
    wallet: &str,
    device_id: &str,
    public_key_hex: &str,
    platform: &str,
    cert: &KeyCertificateBody,
) -> Result<DeviceKeyCertificate, ApiError> {
    if cert.version != KEY_CERTIFICATE_VERSION {
        return Err(ApiError::BadRequest(format!(
            "unsupported key_certificate version {}",
            cert.version
        )));
    }
    if cert.issued_at_ms > Utc::now().timestamp_millis() + KEY_CERTIFICATE_MAX_FUTURE_SKEW_MS {
        return Err(ApiError::BadRequest(
            "key_certificate issued_at_ms is in the future".to_string(),
        ));
    }
    let canonical =
        key_certificate_canonical(wallet, device_id, public_key_hex, platform, cert.issued_at_ms);
    let signature = hex::decode(strip_hex_prefix(cert.signature.trim()))
        .map_err(|e| ApiError::BadRequest(format!("key_certificate.signature: {e}")))?;
    let signer_key = hex::decode(strip_hex_prefix(cert.public_key.trim()))
        .map_err(|e| ApiError::BadRequest(format!("key_certificate.public_key: {e}")))?;
    let request_key = parse_request_key(&signer_key)
        .map_err(|e| ApiError::BadRequest(format!("key_certificate.public_key: {e}")))?;
    verify_request_sender(canonical.as_bytes(), &signature, &request_key, wallet)
        .await
        .map_err(|e| ApiError::BadRequest(format!("key_certificate rejected: {e}")))?;
    Ok(DeviceKeyCertificate {
        version: cert.version,
        issued_at_ms: cert.issued_at_ms,
        signature: strip_hex_prefix(cert.signature.trim()).to_ascii_lowercase(),
        public_key: strip_hex_prefix(cert.public_key.trim()).to_ascii_lowercase(),
    })
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

    let device_id = body.device_id.trim().to_string();
    let public_key = body.public_key.trim().to_string();
    let platform = body.platform.to_ascii_lowercase();
    let receipt_public_key = match body.receipt_public_key.as_deref().map(str::trim) {
        Some(raw) if !raw.is_empty() => {
            let hex_key = strip_hex_prefix(raw).to_ascii_lowercase();
            let bytes = hex::decode(&hex_key)
                .map_err(|_| ApiError::BadRequest("receipt_public_key must be hex".to_string()))?;
            if bytes.len() != 32 {
                return Err(ApiError::BadRequest(
                    "receipt_public_key must be a 32-byte Ed25519 key".to_string(),
                ));
            }
            Some(hex_key)
        }
        _ => None,
    };
    let certificate = match &body.key_certificate {
        Some(cert) => Some(
            verify_key_certificate(&auth.sender_address, &device_id, &public_key, &platform, cert)
                .await?,
        ),
        None => None,
    };

    state
        .notification_push
        .save_device_key(DeviceNotificationKeyRecord {
            wallet: auth.sender_address.clone(),
            device_id,
            public_key,
            platform,
            updated_at: Utc::now(),
            certificate,
            receipt_public_key,
        })
        .await
        .map_err(|e| ApiError::Internal(format!("notification key save failed: {e}")))?;

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
        ApiError::BadRequest("notification_mode must be all, badge_only, or none".to_string())
    })?;
    state
        .notification_push
        .save_wallet_mode(&auth.sender_address, mode)
        .await
        .map_err(|e| ApiError::Internal(format!("notification prefs save failed: {e}")))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn get_group_notification_keys(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(group_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let members = state.membership_store.list_member_addresses(&group_id);
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
                // Senders verify this themselves before sealing a preview; null = unsigned.
                "key_certificate": k.certificate.as_ref().map(|c| serde_json::json!({
                    "version": c.version,
                    "issued_at_ms": c.issued_at_ms,
                    "signature": c.signature,
                    "public_key": c.public_key,
                })),
            })
        })
        .collect::<Vec<_>>();
    // Zero keys here means every recipient push falls back to "New message".
    tracing::info!(
        "notification keys group={} members={} keys={} cached_total={}",
        group_id,
        members.len(),
        keys.len(),
        state.notification_push.device_key_count()
    );
    Ok(Json(serde_json::json!({ "items": keys })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use myso_crypto::ed25519::Ed25519PrivateKey;
    use myso_crypto::MySoSigner;
    use myso_sdk_types::PersonalMessage;
    use std::borrow::Cow;

    /// Same vector as iOS `DeviceNotificationKeyCertificateTests`.
    #[test]
    fn canonical_is_normalized() {
        assert_eq!(
            key_certificate_canonical("0xABC", " dev-1 ", "0xDEADBEEF", "iOS", 1_700_000_000_000),
            "myso-notification-key-v1:0xabc:dev-1:deadbeef:ios:1700000000000"
        );
    }

    fn signed_cert(signing: &Ed25519PrivateKey, wallet: &str, key_hex: &str, issued: i64) -> KeyCertificateBody {
        let canonical = key_certificate_canonical(wallet, "dev-1", key_hex, "ios", issued);
        let user_sig = signing
            .sign_personal_message(&PersonalMessage(Cow::Borrowed(canonical.as_bytes())))
            .unwrap()
            .to_bytes();
        let mut flagged = vec![0x00];
        flagged.extend_from_slice(signing.public_key().as_bytes());
        KeyCertificateBody {
            version: KEY_CERTIFICATE_VERSION,
            issued_at_ms: issued,
            signature: hex::encode(&user_sig[1..65]),
            public_key: hex::encode(flagged),
        }
    }

    fn address_of(signing: &Ed25519PrivateKey) -> String {
        crate::auth::signature::derive_myso_address(
            signing.public_key().as_bytes(),
            crate::auth::schemes::SignatureScheme::Ed25519,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn accepts_wallet_signed_certificate() {
        let signing = Ed25519PrivateKey::new([7u8; 32]);
        let wallet = address_of(&signing);
        let now = Utc::now().timestamp_millis();
        let cert = signed_cert(&signing, &wallet, "aa".repeat(32).as_str(), now);
        let stored = verify_key_certificate(&wallet, "dev-1", &"aa".repeat(32), "ios", &cert)
            .await
            .expect("valid certificate");
        assert_eq!(stored.issued_at_ms, now);
    }

    #[tokio::test]
    async fn rejects_certificate_for_a_substituted_key() {
        let signing = Ed25519PrivateKey::new([7u8; 32]);
        let wallet = address_of(&signing);
        let now = Utc::now().timestamp_millis();
        let cert = signed_cert(&signing, &wallet, &"aa".repeat(32), now);
        assert!(verify_key_certificate(&wallet, "dev-1", &"bb".repeat(32), "ios", &cert)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn rejects_certificate_signed_by_another_wallet() {
        let signing = Ed25519PrivateKey::new([7u8; 32]);
        let other = Ed25519PrivateKey::new([9u8; 32]);
        let wallet = address_of(&signing);
        let now = Utc::now().timestamp_millis();
        let cert = signed_cert(&other, &wallet, &"aa".repeat(32), now);
        assert!(verify_key_certificate(&wallet, "dev-1", &"aa".repeat(32), "ios", &cert)
            .await
            .is_err());
    }
}

#[derive(Debug, Deserialize)]
pub struct PostPushDeliveredBody {
    pub wallet: String,
    pub device_id: String,
    pub message_id: String,
    pub timestamp: i64,
    pub signature: String,
}

pub fn push_delivered_canonical(timestamp: i64, wallet: &str, device_id: &str, message_id: &str) -> String {
    format!("push-delivered:{timestamp}:{wallet}:{device_id}:{message_id}")
}

pub async fn post_push_delivered(
    State(state): State<AppState>,
    Json(body): Json<PostPushDeliveredBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    crate::auth::signature::validate_timestamp(body.timestamp, 300)
        .map_err(|_| ApiError::Unauthorized("receipt timestamp expired".to_string()))?;
    let wallet = body.wallet.trim().to_ascii_lowercase();
    let device_id = body.device_id.trim().to_string();
    let message_id = body.message_id.trim().to_ascii_lowercase();

    let record = state
        .notification_push
        .device_key(&wallet, &device_id)
        .ok_or_else(|| ApiError::Unauthorized("unknown device".to_string()))?;
    let receipt_key = record
        .receipt_public_key
        .ok_or_else(|| ApiError::Unauthorized("device has no receipt key".to_string()))?;
    let key_bytes: [u8; 32] = hex::decode(&receipt_key)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| ApiError::Unauthorized("invalid receipt key".to_string()))?;
    let signature_bytes: [u8; 64] = hex::decode(strip_hex_prefix(body.signature.trim()))
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| ApiError::Unauthorized("invalid signature".to_string()))?;
    let verifying_key = VerifyingKey::from_bytes(&key_bytes)
        .map_err(|_| ApiError::Unauthorized("invalid receipt key".to_string()))?;
    let canonical = push_delivered_canonical(body.timestamp, &wallet, &device_id, &message_id);
    verifying_key
        .verify(canonical.as_bytes(), &Signature::from_bytes(&signature_bytes))
        .map_err(|_| ApiError::Unauthorized("signature verification failed".to_string()))?;

    let message_uuid = uuid::Uuid::parse_str(&message_id)
        .map_err(|_| ApiError::BadRequest("message_id must be a UUID".to_string()))?;
    let message = state
        .storage
        .get_message(message_uuid)
        .await
        .map_err(ApiError::from)?;
    let Some(order) = message.order.filter(|o| *o > 0) else {
        return Ok(Json(serde_json::json!({ "ok": true })));
    };
    let group_id = message.group_id.clone();
    if !state.membership_store.is_member(&group_id, &wallet) {
        return Err(ApiError::Forbidden("Not a member of this group".to_string()));
    }

    let prefs = state
        .storage
        .get_conversation_preferences(&group_id, &wallet)
        .await
        .map_err(ApiError::from)?
        .unwrap_or_else(crate::models::ConversationPreferences::defaults);
    if prefs.receipt_mode.as_str() == "none" {
        return Ok(Json(serde_json::json!({ "ok": true })));
    }
    let updated = state
        .storage
        .advance_member_receipts(&group_id, &wallet, Some(order as u64), None)
        .await
        .map_err(ApiError::from)?;
    if let Some(receipt) = updated {
        if state.realtime_enabled && state.inline_realtime_publish {
            state.realtime_hub.publish_receipt(
                &group_id,
                crate::services::realtime::ReceiptUpdatedEvent::new(group_id.clone(), &receipt),
            );
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod push_delivered_tests {
    use super::push_delivered_canonical;
    use ed25519_dalek::{Signer, SigningKey, Verifier};

    #[test]
    fn canonical_round_trips_with_ed25519() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let canonical = push_delivered_canonical(1_700_000_000, "0xabc", "device-1", "msg-1");
        assert_eq!(canonical, "push-delivered:1700000000:0xabc:device-1:msg-1");
        let signature = key.sign(canonical.as_bytes());
        assert!(key.verifying_key().verify(canonical.as_bytes(), &signature).is_ok());
    }
}
