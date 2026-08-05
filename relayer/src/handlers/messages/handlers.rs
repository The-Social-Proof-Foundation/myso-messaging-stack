//! HTTP handler functions for message CRUD operations.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use uuid::Uuid;

use crate::auth::signature::verify_signature;
use crate::auth::AuthContext;
use crate::models::{Attachment, Message, MessageAttribution, MessageKind};
use crate::state::AppState;
use crate::storage::StorageError;

use super::error::ApiError;
use super::request::{
    AttachmentRequest, CreateMessageRequest, GetMessagesQuery, UpdateMessageRequest,
};
use super::response::{
    CreateMessageResponse, EmptyResponse, GetMessagesResponse, MessageResponse,
    MessagesListResponse,
};

/// Default number of messages per page
const DEFAULT_PAGE_LIMIT: usize = 50;
/// Maximum allowed messages per page
const MAX_PAGE_LIMIT: usize = 100;

/// POST /messages - Create a new message
pub async fn create_message(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(req): Json<CreateMessageRequest>,
) -> Result<(StatusCode, Json<CreateMessageResponse>), ApiError> {
    // Decode hex-encoded encrypted text
    let encrypted_msg = hex::decode(&req.encrypted_text)
        .map_err(|e| ApiError::BadRequest(format!("Invalid hex in encrypted_text: {}", e)))?;

    // Decode hex-encoded nonce
    let nonce = hex::decode(&req.nonce)
        .map_err(|e| ApiError::BadRequest(format!("Invalid hex in nonce: {}", e)))?;
    if nonce.len() != 12 {
        return Err(ApiError::BadRequest(format!(
            "Nonce must be exactly 12 bytes, got {}",
            nonce.len()
        )));
    }

    let kind_str = req.kind.as_deref().unwrap_or("text");
    let kind = MessageKind::parse_client_kind(kind_str).ok_or_else(|| {
        ApiError::BadRequest(format!(
            "Invalid message kind '{}': expected text, post, request_payment, or poll",
            kind_str
        ))
    })?;

    let idempotency_key = req
        .idempotency_key
        .as_ref()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());

    let shared_post_address = if kind == MessageKind::Post {
        let raw = req
            .shared_post_address
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ApiError::BadRequest(
                    "shared_post_address is required when kind is post".into(),
                )
            })?;
        let normalized = normalize_shared_post_address(raw).ok_or_else(|| {
            ApiError::BadRequest(
                "shared_post_address must be 0x + 64 hex (on-chain post id)".into(),
            )
        })?;
        if idempotency_key.is_none() {
            return Err(ApiError::BadRequest(
                "idempotency_key is required when kind is post".into(),
            ));
        }
        Some(normalized)
    } else {
        None
    };

    // Verify per-message signature over canonical content (includes kind;
    // post binds shared_post_address + idempotency_key).
    let signature = verify_message_signature(
        &req.message_signature,
        &req.group_id,
        kind.as_str(),
        &req.encrypted_text,
        &req.nonce,
        req.key_version,
        &auth,
        shared_post_address.as_deref(),
        idempotency_key.as_deref(),
    )?;

    let attachments = decode_attachments(req.attachments)?;

    let attribution = validate_message_attribution(
        &req.sender_address,
        req.principal_owner.as_deref(),
        req.sub_agent_id.as_deref(),
        req.identity_class,
    )?;

    if attribution.is_agent_message() {
        if let (Some(principal), Some(sub_agent)) = (
            attribution.principal_owner.as_deref(),
            attribution.sub_agent_id.as_deref(),
        ) {
            state
                .attribution_verify
                .verify_agent_attribution_or_warn(&req.sender_address, principal, sub_agent)
                .await
                .map_err(|e| ApiError::BadRequest(e.to_string()))?;
        }
    }

    // Resolve the 1:1 DM peer once (exactly one other member in the group's
    // on-chain-synced membership) — shared by the block check and paid-DM gate.
    let dm_peer: Option<String> = if state.block_check.is_enabled()
        || state.message_gate.is_enabled()
    {
        let members = state
            .membership_store
            .list_member_addresses(&req.group_id);
        let mut peers = members.into_iter().filter(|m| m != &req.sender_address);
        match (peers.next(), peers.next()) {
            (Some(peer), None) => Some(peer),
            _ => None,
        }
    } else {
        None
    };

    // DM block check
    if state.block_check.is_enabled() {
        if let Some(peer_addr) = dm_peer.as_deref() {
            let blocked = state
                .block_check
                .check_either_blocked(&req.sender_address, peer_addr)
                .await
                .map_err(|e| ApiError::Internal(format!("Block check unavailable: {}", e)))?;
            if blocked {
                return Err(ApiError::Blocked);
            }
            if let Some(principal) = attribution.principal_owner.as_deref() {
                let principal_blocked = state
                    .block_check
                    .check_either_blocked(principal, peer_addr)
                    .await
                    .map_err(|e| {
                        ApiError::Internal(format!("Block check unavailable: {}", e))
                    })?;
                if principal_blocked {
                    return Err(ApiError::Blocked);
                }
            }
        }
    }

    // Paid-DM gate: a first outbound message from this sender into a DM whose
    // recipient enabled paid messaging requires an indexed on-chain escrow
    // (authoritative chain state — mirrors messaging::assert_paid_open_allowed).
    if state.message_gate.is_enabled() {
        if let Some(peer_addr) = dm_peer.as_deref() {
            let gate = crate::handlers::dm_gate::evaluate_paid_dm_gate(
                &state,
                Some(&req.group_id),
                &req.sender_address,
                attribution.principal_owner.as_deref(),
                peer_addr,
                false,
            )
            .await?;
            if gate.payment_required {
                return Err(ApiError::PaymentRequired {
                    min_cost: gate.min_cost,
                    recipient: peer_addr.to_string(),
                });
            }
        }
    }

    // Build the public key with flag prefix for storage
    let mut public_key_with_flag = vec![auth.scheme.flag()];
    public_key_with_flag.extend_from_slice(&auth.public_key);

    let group_id = req.group_id.clone();
    let sender_address = req.sender_address.clone();

    // Create message domain object
    let message = Message::with_attribution(
        req.group_id,
        req.sender_address,
        encrypted_msg,
        nonce,
        req.key_version,
        attachments,
        signature,
        public_key_with_flag,
        attribution,
        kind,
        idempotency_key.clone(),
    );

    // Store message — idempotent create returns existing row on key conflict.
    let created = match state.storage.create_message(message).await {
        Ok(m) => m,
        Err(StorageError::DuplicateIdempotencyKey) => {
            if let Some(key) = idempotency_key.as_deref() {
                if let Some(existing) = state
                    .storage
                    .get_message_by_idempotency_key(key)
                    .await?
                {
                    return Ok((
                        StatusCode::OK,
                        Json(CreateMessageResponse {
                            message_id: existing.id,
                        }),
                    ));
                }
            }
            return Err(StorageError::DuplicateIdempotencyKey.into());
        }
        Err(e) => return Err(e.into()),
    };

    // Human tip wins over a pending invitee-join debounce.
    state.begin_chat_notify.cancel(&group_id);

    if state.realtime_enabled && state.inline_realtime_publish {
        let wire: MessageResponse = created.clone().into();
        state
            .realtime_hub
            .publish_wire(&group_id, wire);
    }

    // Dripdrop share-count: notify after accept+persist (not recipient ACK).
    if kind == MessageKind::Post {
        if let Some(post_address) = shared_post_address.clone() {
            let destination_type =
                resolve_destination_type(&state, &group_id, &sender_address);
            state.share_webhook.notify_post_share(
                created.id,
                post_address,
                sender_address.clone(),
                destination_type,
                created.created_at,
            );
        }
    }

    // Notify push worker for offline group members (metadata-only APNs).
    let push = state.push_service.clone();
    let storage = state.storage.clone();
    let membership = state.membership_store.clone();
    let push_attribution = created.attribution.clone();
    let push_group_id = group_id.clone();
    let push_sender = sender_address.clone();
    tokio::spawn(async move {
        push
            .notify_new_message(
                &storage,
                &membership,
                &push_group_id,
                &push_sender,
                &push_attribution,
            )
            .await;
    });

    // Notify the File Storage sync worker that a new message was created.
    let _ = state.sync_notifier.send(());

    Ok((
        StatusCode::CREATED,
        Json(CreateMessageResponse {
            message_id: created.id,
        }),
    ))
}

/// GET /messages - Get single message or paginated list
/// Only returns messages belonging to the group the caller is authorized for.
pub async fn get_messages(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Query(query): Query<GetMessagesQuery>,
) -> Result<Json<GetMessagesResponse>, ApiError> {
    // If message_id is provided, return single message
    if let Some(message_id) = query.message_id {
        let message = state.storage.get_message(message_id).await?;

        // Verify the message belongs to the group the caller is authorized for
        if auth.authorized_group.as_deref() != Some(message.group_id.as_str()) {
            return Err(ApiError::Forbidden(
                "Message does not belong to the authorized group".to_string(),
            ));
        }

        let response: MessageResponse = message.into();
        return Ok(Json(GetMessagesResponse::Single(response)));
    }

    // Otherwise, require group_id for paginated list
    let group_id = query
        .group_id
        .ok_or_else(|| ApiError::BadRequest("Either message_id or group_id is required".into()))?;

    // Verify the requested group matches the caller's authorized group
    if auth.authorized_group.as_deref() != Some(group_id.as_str()) {
        return Err(ApiError::Forbidden(
            "Not authorized for this group".to_string(),
        ));
    }

    let limit = query
        .limit
        .unwrap_or(DEFAULT_PAGE_LIMIT)
        .min(MAX_PAGE_LIMIT);

    // Fetch one extra to determine hasNext.
    // Storage returns ascending order (oldest → newest) within the page window.
    // - after_order set: oldest-first of newer messages → keep the first `limit`
    // - otherwise (initial / before_order): newest window → keep the last `limit`
    //   so the absolute newest message is never dropped when trimming hasNext.
    let fetched = state
        .storage
        .get_messages_by_group(&group_id, query.after_order, query.before_order, limit + 1)
        .await?;

    let has_next = fetched.len() > limit;
    let page = if query.after_order.is_some() {
        fetched.into_iter().take(limit).collect::<Vec<_>>()
    } else {
        let skip = fetched.len().saturating_sub(limit);
        fetched.into_iter().skip(skip).take(limit).collect::<Vec<_>>()
    };
    let messages: Vec<MessageResponse> = page.into_iter().map(|m| m.into()).collect();

    let response = MessagesListResponse { messages, has_next };
    Ok(Json(GetMessagesResponse::List(response)))
}

/// PUT /messages - Update a message
/// Only the original message sender can edit their own message.
pub async fn update_message(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(req): Json<UpdateMessageRequest>,
) -> Result<Json<EmptyResponse>, ApiError> {
    // Fetch existing message to verify ownership and group membership
    let existing_message = state.storage.get_message(req.message_id).await?;

    // Verify the message belongs to the group the user is authorized for (middleware-verified)
    if auth.authorized_group.as_deref() != Some(existing_message.group_id.as_str()) {
        return Err(ApiError::Forbidden(
            "Message does not belong to the authorized group".to_string(),
        ));
    }

    if existing_message.is_system() {
        return Err(ApiError::BadRequest(
            "System messages are immutable".to_string(),
        ));
    }
    if existing_message.kind == MessageKind::Post {
        return Err(ApiError::BadRequest(
            "Post share messages are immutable".to_string(),
        ));
    }

    // Only the original sender can edit their message (middleware-verified address)
    if existing_message.sender_wallet_addr != auth.sender_address {
        return Err(ApiError::Forbidden(
            "Only the original sender can edit this message".to_string(),
        ));
    }

    // Decode hex-encoded encrypted text
    let encrypted_msg = hex::decode(&req.encrypted_text)
        .map_err(|e| ApiError::BadRequest(format!("Invalid hex in encrypted_text: {}", e)))?;

    // Decode hex-encoded nonce
    let nonce = hex::decode(&req.nonce)
        .map_err(|e| ApiError::BadRequest(format!("Invalid hex in nonce: {}", e)))?;
    if nonce.len() != 12 {
        return Err(ApiError::BadRequest(format!(
            "Nonce must be exactly 12 bytes, got {}",
            nonce.len()
        )));
    }

    // Verify per-message signature over canonical content (kind of existing row).
    // Edits of post messages keep the text-style bind (shared_post not re-bound on update).
    let signature = verify_message_signature(
        &req.message_signature,
        &req.group_id,
        existing_message.kind.as_str(),
        &req.encrypted_text,
        &req.nonce,
        req.key_version,
        &auth,
        None,
        None,
    )?;

    let attachments = decode_attachments(req.attachments)?;

    let mut public_key_with_flag = vec![auth.scheme.flag()];
    public_key_with_flag.extend_from_slice(&auth.public_key);

    // Update message
    let updated = state
        .storage
        .update_message(
            req.message_id,
            encrypted_msg,
            nonce,
            req.key_version,
            attachments,
            signature,
            public_key_with_flag,
        )
        .await?;

    // Open-thread edit fan-out (no activity bump / push).
    if state.realtime_enabled && state.inline_realtime_publish {
        let wire: MessageResponse = updated.into();
        state
            .realtime_hub
            .publish_edited_wire(&existing_message.group_id, wire);
    }

    Ok(Json(EmptyResponse {}))
}

/// DELETE /messages/:message_id - Soft delete a message
/// Only the original message sender can delete their own message.
pub async fn delete_message(
    State(state): State<AppState>,
    Path(message_id): Path<Uuid>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<EmptyResponse>, ApiError> {
    // Fetch existing message to verify ownership and group membership
    let existing_message = state.storage.get_message(message_id).await?;

    // Verify the message belongs to the group the user is authorized for
    if auth.authorized_group.as_deref() != Some(existing_message.group_id.as_str()) {
        return Err(ApiError::Forbidden(
            "Message does not belong to the authorized group".to_string(),
        ));
    }

    if existing_message.is_system() {
        return Err(ApiError::BadRequest(
            "System messages are immutable".to_string(),
        ));
    }

    // Only the original sender can delete their message
    if existing_message.sender_wallet_addr != auth.sender_address {
        return Err(ApiError::Forbidden(
            "Only the original sender can delete this message".to_string(),
        ));
    }

    let deleted = state.storage.delete_message(message_id).await?;

    // Open-thread tombstone fan-out (no activity bump / push).
    if state.realtime_enabled && state.inline_realtime_publish {
        let wire: MessageResponse = deleted.into();
        state
            .realtime_hub
            .publish_deleted_wire(&existing_message.group_id, wire);
    }

    Ok(Json(EmptyResponse {}))
}

/// Verifies the per-message signature over canonical content.
/// Default: "{group_id}:{kind}:{encrypted_text}:{nonce}:{key_version}"
/// Post: "{group_id}:post:{shared_post_address}:{idempotency_key}:{encrypted_text}:{nonce}:{key_version}"
fn verify_message_signature(
    signature_hex: &str,
    group_id: &str,
    kind: &str,
    encrypted_text: &str,
    nonce: &str,
    key_version: i64,
    auth: &AuthContext,
    shared_post_address: Option<&str>,
    idempotency_key: Option<&str>,
) -> Result<Vec<u8>, ApiError> {
    let signature_bytes = hex::decode(signature_hex)
        .map_err(|e| ApiError::BadRequest(format!("Invalid hex in message_signature: {}", e)))?;
    if signature_bytes.len() != 64 {
        return Err(ApiError::BadRequest(format!(
            "message_signature must be exactly 64 bytes, got {}",
            signature_bytes.len()
        )));
    }

    let canonical = if kind == "post" {
        let post = shared_post_address.unwrap_or("");
        let idem = idempotency_key.unwrap_or("");
        format!(
            "{}:{}:{}:{}:{}:{}:{}",
            group_id, kind, post, idem, encrypted_text, nonce, key_version
        )
    } else {
        format!(
            "{}:{}:{}:{}:{}",
            group_id, kind, encrypted_text, nonce, key_version
        )
    };

    verify_signature(
        canonical.as_bytes(),
        &signature_bytes,
        &auth.public_key,
        auth.scheme,
    )
    .map_err(|e| ApiError::BadRequest(format!("Message signature verification failed: {}", e)))?;

    Ok(signature_bytes)
}

fn normalize_shared_post_address(raw: &str) -> Option<String> {
    let s = raw.trim().to_ascii_lowercase();
    let hex = s.strip_prefix("0x")?;
    if hex.is_empty() || hex.len() > 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("0x{:0>64}", hex))
}

#[cfg(test)]
mod shared_post_canonical_tests {
    use super::*;

    #[test]
    fn normalize_pads_short_hex() {
        assert_eq!(
            normalize_shared_post_address("0xabc"),
            Some(format!("0x{}abc", "0".repeat(61)))
        );
    }

    #[test]
    fn normalize_lowercases_full_id() {
        let upper = format!("0x{}", "AB".repeat(32));
        let lower = format!("0x{}", "ab".repeat(32));
        assert_eq!(normalize_shared_post_address(&upper), Some(lower));
    }

    #[test]
    fn post_canonical_matches_client_shape() {
        let group = "0xGROUP_MIXED";
        let post = normalize_shared_post_address("0xabc").unwrap();
        let padded = format!("0x{}abc", "0".repeat(61));
        let canonical = format!(
            "{}:post:{}:idem-1:deadbeef:000000000000000000000000:0",
            group.to_ascii_lowercase(),
            post
        );
        assert_eq!(
            canonical,
            format!("0xgroup_mixed:post:{padded}:idem-1:deadbeef:000000000000000000000000:0")
        );
        assert_eq!(post, padded);
    }
}

/// `dm` when exactly one peer in membership; otherwise `group`.
fn resolve_destination_type(state: &AppState, group_id: &str, sender: &str) -> &'static str {
    let members = state.membership_store.list_member_addresses(group_id);
    let peers: Vec<_> = members.into_iter().filter(|m| m != sender).collect();
    if peers.len() == 1 {
        "dm"
    } else {
        "group"
    }
}

/// Decodes a list of attachment request DTOs into domain attachments.
fn decode_attachments(requests: Vec<AttachmentRequest>) -> Result<Vec<Attachment>, ApiError> {
    requests
        .into_iter()
        .map(|r| r.try_into_attachment().map_err(ApiError::BadRequest))
        .collect()
}

fn validate_message_attribution(
    sender_address: &str,
    principal_owner: Option<&str>,
    sub_agent_id: Option<&str>,
    identity_class: Option<i16>,
) -> Result<MessageAttribution, ApiError> {
    let has_any = principal_owner.is_some() || sub_agent_id.is_some() || identity_class.is_some();
    if !has_any {
        return Ok(MessageAttribution::human_message());
    }
    let principal = principal_owner.ok_or_else(|| {
        ApiError::BadRequest("principal_owner required for agent attribution".into())
    })?;
    let sub_agent = sub_agent_id.ok_or_else(|| {
        ApiError::BadRequest("sub_agent_id required for agent attribution".into())
    })?;
    let class = identity_class.ok_or_else(|| {
        ApiError::BadRequest("identity_class required for agent attribution".into())
    })?;
    if sender_address == principal {
        return Err(ApiError::BadRequest(
            "sender_address cannot equal principal_owner for agent messages".into(),
        ));
    }
    Ok(MessageAttribution {
        principal_owner: Some(principal.to_string()),
        sub_agent_id: Some(sub_agent.to_string()),
        identity_class: Some(class),
        attribution_version: 1,
    })
}
