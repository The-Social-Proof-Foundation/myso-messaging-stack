//! `/v1/groups/...` endpoints: off-chain mirrors for reactions, pins, and
//! receipts, plus ephemeral typing/presence (never persisted).

use axum::extract::{Path, Query, State};
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::auth::AuthContext;
use crate::handlers::messages::error::ApiError;
use crate::models::{
    ConversationPreferences, ConversationPreferencesPatch, GroupReceiptsResponse, ReactionEntry,
};
use crate::services::realtime::{ReactionUpdatedEvent, ReceiptUpdatedEvent, TypingEvent};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct ReactionsQuery {
    pub chain_seq: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct PostReactionBody {
    pub chain_seq: i64,
    /// Canonical Unicode emoji string (NFC). Supports skin tones, ZWJ
    /// sequences, and variation selectors.
    pub emoji: String,
    #[serde(default = "default_true")]
    pub add: bool,
}

/// Generous cap: the longest RGI emoji ZWJ sequences are ~35 bytes of UTF-8.
const MAX_REACTION_EMOJI_BYTES: usize = 64;

/// Boundary validation for reaction emoji. Clients canonicalize (NFC) before
/// sending; the relayer only rejects clearly invalid payloads.
fn validate_reaction_emoji(emoji: &str) -> Result<(), ApiError> {
    if emoji.is_empty() {
        return Err(ApiError::BadRequest("emoji must not be empty".to_string()));
    }
    if emoji.len() > MAX_REACTION_EMOJI_BYTES {
        return Err(ApiError::BadRequest(format!(
            "emoji must be at most {MAX_REACTION_EMOJI_BYTES} bytes"
        )));
    }
    if emoji.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(ApiError::BadRequest(
            "emoji must not contain control or whitespace characters".to_string(),
        ));
    }
    Ok(())
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

#[derive(Debug, Deserialize)]
pub struct PutPrefsBody {
    pub notification_mode: Option<String>,
    pub receipt_mode: Option<String>,
}

fn validate_notification_mode(mode: &str) -> Result<(), ApiError> {
    match mode {
        "all" | "none" => Ok(()),
        _ => Err(ApiError::BadRequest(
            "notification_mode must be 'all' or 'none'".to_string(),
        )),
    }
}

fn validate_receipt_mode(mode: &str) -> Result<(), ApiError> {
    match mode {
        "full" | "delivered_only" | "none" => Ok(()),
        _ => Err(ApiError::BadRequest(
            "receipt_mode must be 'full', 'delivered_only', or 'none'".to_string(),
        )),
    }
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
    validate_reaction_emoji(&body.emoji)?;
    let updated = state
        .storage
        .set_reaction(
            &group_id,
            body.chain_seq,
            &body.emoji,
            auth.sender_address.as_str(),
            body.add,
        )
        .await
        .map_err(ApiError::from)?;

    // Postgres storage fans out via pg_notify; inline publish covers in-memory.
    if let Some(entry) = &updated {
        if state.realtime_enabled && state.inline_realtime_publish {
            state
                .realtime_hub
                .publish_reaction(&group_id, ReactionUpdatedEvent::new(group_id.clone(), entry));
        }
    }

    Ok(Json(serde_json::json!({ "ok": true, "changed": updated.is_some() })))
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

#[derive(Debug, Deserialize)]
pub struct PostTypingBody {
    /// `true` -> broadcast `typing.start`, `false` -> `typing.stop`.
    pub typing: bool,
}

/// Ephemeral typing indicator — broadcast only, zero storage writes.
///
/// `typing.start` is rate-limited per (wallet, group); `typing.stop` always
/// passes so a stop is never dropped. The event's TTL (`expires_at`) is the
/// recovery mechanism when a stop never arrives.
pub async fn post_typing(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PostTypingBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    ensure_group(&auth, &group_id)?;

    if !state.realtime_enabled {
        return Ok(Json(serde_json::json!({ "ok": true, "broadcast": false })));
    }

    if body.typing && !state.typing_rate.allow_start(&auth.sender_address, &group_id) {
        return Ok(Json(serde_json::json!({ "ok": true, "broadcast": false })));
    }

    let event = if body.typing {
        TypingEvent::start(group_id.clone(), auth.sender_address.clone())
    } else {
        TypingEvent::stop(group_id.clone(), auth.sender_address.clone())
    };

    if state.inline_realtime_publish {
        state.realtime_hub.publish_typing(&group_id, event);
    } else {
        // Postgres mode: one NOTIFY; every instance (including this one)
        // delivers via its LISTEN worker.
        match serde_json::to_string(&event) {
            Ok(payload) => {
                if let Err(err) = state.storage.notify_realtime_event(&payload).await {
                    warn!("typing notify failed for group {}: {}", group_id, err);
                }
            }
            Err(err) => warn!("typing event serialize failed: {}", err),
        }
    }

    Ok(Json(serde_json::json!({ "ok": true, "broadcast": true })))
}

#[derive(Debug, Serialize)]
pub struct PresenceEntry {
    pub member: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    pub online: bool,
}

/// Presence snapshot for initial render. `online` comes from the live
/// WebSocket registry on this instance; `last_seen` is storage-backed for
/// “last online …” labels. Live transitions also arrive as `presence.updated`
/// on the group WebSocket.
pub async fn get_group_presence(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<Vec<PresenceEntry>>, ApiError> {
    ensure_group(&auth, &group_id)?;

    let mut entries = Vec::new();
    for member in state.membership_store.list_member_addresses(&group_id) {
        let last_seen = state
            .storage
            .get_presence_last_seen(&member)
            .await
            .map_err(ApiError::from)?;
        let online = state.presence_registry.is_online(&member);
        entries.push(PresenceEntry {
            member,
            last_seen: last_seen.map(|t| t.to_rfc3339()),
            online,
        });
    }

    Ok(Json(entries))
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
    let prefs = state
        .storage
        .get_conversation_preferences(&group_id, member)
        .await
        .map_err(ApiError::from)?
        .unwrap_or_else(ConversationPreferences::defaults);
    let (delivered_upto, read_upto) = match prefs.receipt_mode.as_str() {
        "none" => (None, None),
        "delivered_only" => (body.delivered_upto, None),
        _ => (body.delivered_upto, body.read_upto),
    };
    let updated = state
        .storage
        .advance_member_receipts(&group_id, member, delivered_upto, read_upto)
        .await
        .map_err(ApiError::from)?;

    if let Some(receipt) = updated {
        if state.realtime_enabled && state.inline_realtime_publish {
            state.realtime_hub.publish_receipt(
                &group_id,
                ReceiptUpdatedEvent::new(group_id.clone(), &receipt),
            );
        }
        return Ok(Json(serde_json::json!({
            "ok": true,
            "member": receipt.member,
            "delivered_upto": receipt.delivered_upto,
            "read_upto": receipt.read_upto,
        })));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn get_receipts(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<GroupReceiptsResponse>, ApiError> {
    ensure_group(&auth, &group_id)?;
    let members = state
        .storage
        .list_group_receipts(&group_id)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(GroupReceiptsResponse { members }))
}

pub async fn get_prefs(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<ConversationPreferences>, ApiError> {
    ensure_group(&auth, &group_id)?;
    let prefs = state
        .storage
        .get_conversation_preferences(&group_id, auth.sender_address.as_str())
        .await
        .map_err(ApiError::from)?
        .unwrap_or_else(ConversationPreferences::defaults);
    Ok(Json(prefs))
}

pub async fn put_prefs(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PutPrefsBody>,
) -> Result<Json<ConversationPreferences>, ApiError> {
    ensure_group(&auth, &group_id)?;
    if body.notification_mode.is_none() && body.receipt_mode.is_none() {
        return Err(ApiError::BadRequest(
            "at least one of notification_mode or receipt_mode is required".to_string(),
        ));
    }
    if let Some(ref mode) = body.notification_mode {
        validate_notification_mode(mode)?;
    }
    if let Some(ref mode) = body.receipt_mode {
        validate_receipt_mode(mode)?;
    }
    let prefs = state
        .storage
        .upsert_conversation_preferences(
            &group_id,
            auth.sender_address.as_str(),
            ConversationPreferencesPatch {
                notification_mode: body.notification_mode,
                receipt_mode: body.receipt_mode,
            },
        )
        .await
        .map_err(ApiError::from)?;
    Ok(Json(prefs))
}
