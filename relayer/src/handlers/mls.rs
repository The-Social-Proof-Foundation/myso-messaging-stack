//! MLS delivery-service endpoints (E2EE M4). The relayer stores and hands out opaque MLS material;
//! it never holds group secrets. See docs/myso-messaging-stack/E2EE-Protocol-MLS.md.

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use serde::Deserialize;

use crate::auth::request_sender::{parse_request_key, verify_request_sender};
use crate::auth::signature::strip_hex_prefix;
use crate::auth::AuthContext;
use crate::handlers::messages::error::ApiError;
use crate::state::AppState;

const MAX_UPLOAD: usize = 50;
const MAX_CLAIM_WALLETS: usize = 64;

#[derive(Debug, Deserialize)]
pub struct PutKeyPackagesBody {
    pub sender_address: String,
    pub device_id: String,
    /// The device's wallet-signed certificate (also the MLS credential identity).
    pub certificate: myso_mls::DeviceCertificate,
    /// Hex TLS-serialized MLS KeyPackages.
    pub key_packages: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ClaimKeyPackagesBody {
    pub sender_address: String,
    pub wallets: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct WelcomeRecipient {
    pub wallet: String,
    pub device_id: String,
}

#[derive(Debug, Deserialize)]
pub struct PostWelcomeBody {
    pub sender_address: String,
    pub recipients: Vec<WelcomeRecipient>,
    /// Hex TLS-serialized MLS Welcome.
    pub welcome: String,
}

#[derive(Debug, Deserialize)]
pub struct WelcomesQuery {
    pub device_id: String,
}

fn hex_bytes(field: &str, value: &str) -> Result<Vec<u8>, ApiError> {
    hex::decode(strip_hex_prefix(value.trim())).map_err(|e| ApiError::BadRequest(format!("{field}: {e}")))
}

/// v1: the wallet must have signed this exact device key (same verifier as request auth).
/// v2: the device's authority key must have signed it. Whether that authority key is registered
/// for this wallet (and not revoked) is checked by clients against the on-chain registry; the
/// upload itself is already authenticated as `wallet`, so nobody can publish for someone else.
async fn verify_certificate(cert: &myso_mls::DeviceCertificate, wallet: &str) -> Result<(), ApiError> {
    if !cert.wallet.eq_ignore_ascii_case(wallet) {
        return Err(ApiError::Forbidden("certificate is for another wallet".into()));
    }
    if cert.v == myso_mls::certificate::CERTIFICATE_VERSION_V2 {
        return if cert.verify_authority_signature() {
            Ok(())
        } else {
            Err(ApiError::BadRequest("certificate rejected: bad authority signature".into()))
        };
    }
    let signature = hex_bytes("certificate.sig", &cert.sig)?;
    let signer = hex_bytes("certificate.signer_key", &cert.signer_key)?;
    let key = parse_request_key(&signer).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    verify_request_sender(cert.signed_canonical().as_bytes(), &signature, &key, wallet)
        .await
        .map_err(|e| ApiError::BadRequest(format!("certificate rejected: {e}")))?;
    Ok(())
}

/// `POST /v1/mls/key-packages` — a device publishes KeyPackages under its certificate.
pub async fn put_key_packages(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PutKeyPackagesBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !body.sender_address.eq_ignore_ascii_case(&auth.sender_address) {
        return Err(ApiError::Forbidden("sender_address does not match authenticated wallet".into()));
    }
    if body.key_packages.is_empty() || body.key_packages.len() > MAX_UPLOAD {
        return Err(ApiError::BadRequest(format!("upload 1..={MAX_UPLOAD} key packages")));
    }
    if body.certificate.device_id != body.device_id.trim() {
        return Err(ApiError::BadRequest("certificate is for another device".into()));
    }
    verify_certificate(&body.certificate, &auth.sender_address).await?;
    let mut packages = Vec::with_capacity(body.key_packages.len());
    for hex_kp in &body.key_packages {
        let bytes = hex_bytes("key_packages", hex_kp)?;
        let member = myso_mls::key_package_member(&bytes)
            .map_err(|e| ApiError::BadRequest(format!("invalid key package: {e}")))?;
        // Every KeyPackage must carry this certificate and the key it certifies.
        let cert = member
            .certificate()
            .ok_or_else(|| ApiError::BadRequest("key package credential is not a valid certificate".into()))?;
        if cert != body.certificate {
            return Err(ApiError::BadRequest("key package credential differs from certificate".into()));
        }
        packages.push(bytes);
    }
    state
        .mls
        .put_key_packages(&auth.sender_address.to_ascii_lowercase(), body.device_id.trim(), &packages)
        .await
        .map_err(|e| ApiError::Internal(format!("key package store: {e}")))?;
    let _ = state.mls.touch_device(&auth.sender_address.to_ascii_lowercase(), body.device_id.trim()).await;
    Ok(Json(serde_json::json!({ "ok": true, "stored": packages.len() })))
}

/// `POST /v1/mls/key-packages/claim` — one single-use KeyPackage per device of each wallet.
pub async fn claim_key_packages(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<ClaimKeyPackagesBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !body.sender_address.eq_ignore_ascii_case(&auth.sender_address) {
        return Err(ApiError::Forbidden("sender_address does not match authenticated wallet".into()));
    }
    if body.wallets.is_empty() || body.wallets.len() > MAX_CLAIM_WALLETS {
        return Err(ApiError::BadRequest(format!("claim for 1..={MAX_CLAIM_WALLETS} wallets")));
    }
    let wallets: Vec<String> = body.wallets.iter().map(|w| w.trim().to_ascii_lowercase()).collect();
    let claimed = state
        .mls
        .claim_key_packages(&wallets)
        .await
        .map_err(|e| ApiError::Internal(format!("key package claim: {e}")))?;
    let items: Vec<_> = claimed
        .into_iter()
        .map(|c| serde_json::json!({
            "wallet": c.wallet, "device_id": c.device_id, "key_package": hex::encode(c.key_package),
        }))
        .collect();
    Ok(Json(serde_json::json!({ "items": items })))
}

/// `POST /v1/groups/:group_id/mls/welcomes` — a member hands Welcomes to added devices.
pub async fn post_welcome(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(group_id): Path<String>,
    Json(body): Json<PostWelcomeBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if auth.authorized_group.as_deref() != Some(group_id.as_str()) {
        return Err(ApiError::Forbidden("Not authorized for this group".into()));
    }
    if !body.sender_address.eq_ignore_ascii_case(&auth.sender_address) {
        return Err(ApiError::Forbidden("sender_address does not match authenticated wallet".into()));
    }
    let welcome = hex_bytes("welcome", &body.welcome)?;
    if !matches!(myso_mls::inspect(&welcome), Ok(myso_mls::MessageInfo::Welcome)) {
        return Err(ApiError::BadRequest("welcome is not an MLS Welcome".into()));
    }
    // Only current on-chain members can be welcomed.
    let members = state.membership_store.list_member_addresses(&group_id);
    for r in &body.recipients {
        if !members.iter().any(|m| m.eq_ignore_ascii_case(&r.wallet)) {
            return Err(ApiError::Forbidden(format!("{} is not a member of this group", r.wallet)));
        }
    }
    for r in &body.recipients {
        state
            .mls
            .put_welcome(&group_id, &r.wallet.to_ascii_lowercase(), r.device_id.trim(), &welcome)
            .await
            .map_err(|e| ApiError::Internal(format!("welcome store: {e}")))?;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// `GET /v1/mls/welcomes?device_id=` — this device's pending Welcomes (handed out once).
pub async fn take_welcomes(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Query(query): Query<WelcomesQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let wallet = auth.sender_address.to_ascii_lowercase();
    let device_id = query.device_id.trim();
    let items = state
        .mls
        .take_welcomes(&wallet, device_id)
        .await
        .map_err(|e| ApiError::Internal(format!("welcome fetch: {e}")))?;
    // Every device polls this on open and on demand: it doubles as "last active".
    if !device_id.is_empty() && device_id.len() <= 128 {
        let _ = state.mls.touch_device(&wallet, device_id).await;
    }
    let items: Vec<_> = items
        .into_iter()
        .map(|(group_id, welcome)| serde_json::json!({ "group_id": group_id, "welcome": hex::encode(welcome) }))
        .collect();
    Ok(Json(serde_json::json!({ "items": items })))
}

/// `GET /v1/mls/devices` — the caller's devices and when each was last active (unix ms). Only
/// timestamps: clients take the device list itself from their MLS self-group.
pub async fn list_devices(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let devices = state
        .mls
        .devices_seen(&auth.sender_address.to_ascii_lowercase())
        .await
        .map_err(|e| ApiError::Internal(format!("device list: {e}")))?;
    let items: Vec<_> = devices
        .into_iter()
        .map(|d| serde_json::json!({
            "device_id": d.device_id, "first_seen_ms": d.first_seen_ms, "last_seen_ms": d.last_seen_ms,
        }))
        .collect();
    Ok(Json(serde_json::json!({ "items": items })))
}

// === M5: multi-device ===

#[derive(Debug, Deserialize)]
pub struct PutGroupInfoBody {
    pub sender_address: String,
    /// Hex TLS-serialized MLS GroupInfo (with ratchet tree).
    pub group_info: String,
}

#[derive(Debug, Deserialize)]
pub struct PostSelfMessageBody {
    pub sender_address: String,
    /// Hex MLS message for this wallet's self-group (`self:<wallet>`).
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct SelfMessagesQuery {
    #[serde(default)]
    pub after: i64,
    pub limit: Option<i64>,
}

fn self_group_id(wallet: &str) -> String {
    format!("self:{}", wallet.to_ascii_lowercase())
}

/// Validate + store a GroupInfo for `group_id` at the current accepted epoch.
async fn store_group_info(state: &AppState, group_id: &str, hex_info: &str) -> Result<(), ApiError> {
    let info = hex_bytes("group_info", hex_info)?;
    let epoch = match myso_mls::inspect(&info) {
        Ok(myso_mls::MessageInfo::GroupInfo { group_id: g, epoch }) if g == group_id.as_bytes() => epoch,
        _ => return Err(ApiError::BadRequest("group_info is not an MLS GroupInfo for this group".into())),
    };
    if !state
        .mls
        .put_group_info(group_id, epoch, &info)
        .await
        .map_err(|e| ApiError::Internal(format!("group info store: {e}")))?
    {
        return Err(ApiError::Conflict(format!("GroupInfo epoch {epoch} is not the current epoch")));
    }
    Ok(())
}

async fn load_group_info(state: &AppState, group_id: &str) -> Result<Json<serde_json::Value>, ApiError> {
    let (epoch, info) = state
        .mls
        .group_info(group_id)
        .await
        .map_err(|e| ApiError::Internal(format!("group info: {e}")))?
        .ok_or_else(|| ApiError::NotFound("no GroupInfo published for this group".into()))?;
    Ok(Json(serde_json::json!({ "epoch": epoch, "group_info": hex::encode(info) })))
}

/// `POST /v1/groups/:group_id/mls/group-info` — any sending member republishes after each commit
/// (POST: group auth requires MessagingSender, not the Editor permission PUT implies).
pub async fn put_group_info(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(group_id): Path<String>,
    Json(body): Json<PutGroupInfoBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if auth.authorized_group.as_deref() != Some(group_id.as_str()) {
        return Err(ApiError::Forbidden("Not authorized for this group".into()));
    }
    store_group_info(&state, &group_id, &body.group_info).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// `GET /v1/groups/:group_id/mls/group-info` — only on-chain members (group auth) may fetch it;
/// existing members still verify the joiner's certificate when they process its external commit.
pub async fn get_group_info(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(group_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if auth.authorized_group.as_deref() != Some(group_id.as_str()) {
        return Err(ApiError::Forbidden("Not authorized for this group".into()));
    }
    load_group_info(&state, &group_id).await
}

/// `PUT /v1/mls/self/group-info` — this wallet's self-group (own devices only).
pub async fn put_self_group_info(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PutGroupInfoBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    store_group_info(&state, &self_group_id(&auth.sender_address), &body.group_info).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// `GET /v1/mls/self/group-info`
pub async fn get_self_group_info(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<serde_json::Value>, ApiError> {
    load_group_info(&state, &self_group_id(&auth.sender_address)).await
}

/// `POST /v1/mls/self/messages` — append an MLS message to this wallet's self-group log
/// (history bundles, self-group commits; one commit per epoch like any group).
pub async fn post_self_message(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PostSelfMessageBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let group = self_group_id(&auth.sender_address);
    let bytes = hex_bytes("body", &body.body)?;
    match myso_mls::inspect(&bytes) {
        Ok(myso_mls::MessageInfo::Commit { group_id, epoch }) if group_id == group.as_bytes() => {
            if !state
                .mls
                .try_advance_epoch(&group, epoch)
                .await
                .map_err(|e| ApiError::Internal(format!("mls epoch: {e}")))?
            {
                return Err(ApiError::Conflict(format!("stale self-group commit for epoch {epoch}")));
            }
        }
        Ok(myso_mls::MessageInfo::Application { group_id, .. } | myso_mls::MessageInfo::Proposal { group_id, .. })
            if group_id == group.as_bytes() => {}
        _ => return Err(ApiError::BadRequest("body is not an MLS message for this wallet's self-group".into())),
    }
    let seq = state
        .mls
        .append_self(&auth.sender_address.to_ascii_lowercase(), &bytes)
        .await
        .map_err(|e| ApiError::Internal(format!("self log: {e}")))?;
    Ok(Json(serde_json::json!({ "seq": seq })))
}

/// `GET /v1/mls/self/messages?after=&limit=` — this wallet's self-group log in order.
pub async fn get_self_messages(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Query(query): Query<SelfMessagesQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let rows = state
        .mls
        .self_after(&auth.sender_address.to_ascii_lowercase(), query.after, query.limit.unwrap_or(100).clamp(1, 500))
        .await
        .map_err(|e| ApiError::Internal(format!("self log: {e}")))?;
    let items: Vec<_> = rows
        .into_iter()
        .map(|(seq, body)| serde_json::json!({ "seq": seq, "body": hex::encode(body) }))
        .collect();
    Ok(Json(serde_json::json!({ "items": items })))
}

// === M8: passkey-encrypted history backup ===

#[derive(Debug, Deserialize)]
pub struct PostBackupBody {
    pub sender_address: String,
    /// Which passkey-derived key the segment is under (hex, 16..=64 chars).
    pub key_id: String,
    /// Hex ciphertext (opaque to the relayer).
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct BackupQuery {
    pub key_id: String,
    #[serde(default)]
    pub after: i64,
    pub limit: Option<i64>,
}

fn valid_key_id(key_id: &str) -> bool {
    (16..=64).contains(&key_id.len()) && key_id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `POST /v1/mls/backup/segments` — append one encrypted history segment for the caller.
pub async fn post_backup_segment(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PostBackupBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !body.sender_address.eq_ignore_ascii_case(&auth.sender_address) {
        return Err(ApiError::Forbidden("sender_address does not match authenticated wallet".into()));
    }
    let key_id = body.key_id.trim().to_ascii_lowercase();
    if !valid_key_id(&key_id) {
        return Err(ApiError::BadRequest("key_id must be 16..=64 hex chars".into()));
    }
    let bytes = hex_bytes("body", &body.body)?;
    if bytes.is_empty() || bytes.len() > crate::services::mls_store::MAX_BACKUP_SEGMENT_BYTES {
        return Err(ApiError::BadRequest("backup segment must be 1..=786432 bytes".into()));
    }
    match state
        .mls
        .append_backup(&auth.sender_address.to_ascii_lowercase(), &key_id, &bytes)
        .await
        .map_err(|e| ApiError::Internal(format!("backup store: {e}")))?
    {
        crate::services::mls_store::BackupAppend::Stored(seq) => Ok(Json(serde_json::json!({ "seq": seq }))),
        crate::services::mls_store::BackupAppend::QuotaExceeded => {
            Err(ApiError::Conflict("message backup is full; delete it or start a new one".into()))
        }
    }
}

/// `GET /v1/mls/backup/segments?key_id=&after=&limit=` — the caller's segments, in order.
pub async fn get_backup_segments(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Query(query): Query<BackupQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let key_id = query.key_id.trim().to_ascii_lowercase();
    if !valid_key_id(&key_id) {
        return Err(ApiError::BadRequest("key_id must be 16..=64 hex chars".into()));
    }
    let rows = state
        .mls
        .backup_after(&auth.sender_address.to_ascii_lowercase(), &key_id, query.after, query.limit.unwrap_or(20).clamp(1, 50))
        .await
        .map_err(|e| ApiError::Internal(format!("backup store: {e}")))?;
    let items: Vec<_> = rows
        .into_iter()
        .map(|(seq, body, created_ms)| serde_json::json!({ "seq": seq, "body": hex::encode(body), "created_ms": created_ms }))
        .collect();
    Ok(Json(serde_json::json!({ "items": items })))
}

/// `DELETE /v1/mls/backup/:key_id` — delete the caller's backup under that key (turned off).
pub async fn delete_backup(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(key_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let key_id = key_id.trim().to_ascii_lowercase();
    if !valid_key_id(&key_id) {
        return Err(ApiError::BadRequest("key_id must be 16..=64 hex chars".into()));
    }
    let deleted = state
        .mls
        .delete_backup(&auth.sender_address.to_ascii_lowercase(), &key_id)
        .await
        .map_err(|e| ApiError::Internal(format!("backup store: {e}")))?;
    Ok(Json(serde_json::json!({ "ok": true, "deleted": deleted })))
}

/// `DELETE /v1/mls/devices/:device_id` — logout: no one can add this device again.
pub async fn delete_device(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(device_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state
        .mls
        .delete_device_key_packages(&auth.sender_address.to_ascii_lowercase(), device_id.trim())
        .await
        .map_err(|e| ApiError::Internal(format!("device delete: {e}")))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
