//! 1:1 DM payment request actions (`request_payment` reject / cancel).
//!
//! Confirm is not an endpoint: the payer submits the on-chain transfer and posts a
//! `token_transfer` message with `metadata.request_message_id`, which links and settles the
//! request (see `services::transfer_confirmation`).

use axum::{extract::State, Extension, Json};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::AuthContext;
use crate::models::payment_metadata::{metadata_status, RequestAction, RequestStatus};
use crate::models::MessageKind;
use crate::services::transfer_confirmation::normalize_address;
use crate::state::AppState;

use super::error::ApiError;
use super::response::MessageResponse;

/// Request body for POST /messages/respond.
/// `group_id`, `sender_address` and `timestamp` are consumed by the auth middleware.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct RespondToPaymentRequestBody {
    pub group_id: String,
    pub sender_address: String,
    pub timestamp: i64,
    /// The `request_payment` message to act on.
    pub message_id: Uuid,
    /// `reject` (payer) or `cancel` (requester).
    pub action: String,
}

/// POST /messages/respond - reject (payer) or cancel (requester) an open payment request.
pub async fn respond_to_payment_request(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(req): Json<RespondToPaymentRequestBody>,
) -> Result<Json<MessageResponse>, ApiError> {
    let action = RequestAction::parse(req.action.trim()).ok_or_else(|| {
        ApiError::BadRequest("action must be reject or cancel".to_string())
    })?;

    let request = state.storage.get_message(req.message_id).await?;
    if auth.authorized_group.as_deref() != Some(request.group_id.as_str()) {
        return Err(ApiError::Forbidden(
            "Message does not belong to the authorized group".to_string(),
        ));
    }
    if request.kind != MessageKind::RequestPayment {
        return Err(ApiError::BadRequest(
            "Message is not a payment request".to_string(),
        ));
    }

    let actor = normalize_address(&auth.sender_address);
    match action {
        RequestAction::Reject => {
            let payer = request
                .metadata
                .as_ref()
                .and_then(|m| m.get("payer"))
                .and_then(|v| v.as_str())
                .map(normalize_address);
            if payer.as_deref() != Some(actor.as_str()) {
                return Err(ApiError::Forbidden(
                    "Only the payer can reject a payment request".to_string(),
                ));
            }
        }
        RequestAction::Cancel => {
            if normalize_address(&request.sender_wallet_addr) != actor {
                return Err(ApiError::Forbidden(
                    "Only the requester can cancel a payment request".to_string(),
                ));
            }
        }
    }

    if metadata_status(request.metadata.as_ref()) != Some(RequestStatus::Open.as_str()) {
        return Err(ApiError::Conflict(
            "Payment request is no longer open".to_string(),
        ));
    }

    let patch = serde_json::json!({ "status": action.target_status().as_str() });
    // CAS on status: if a transfer links (open -> paid) concurrently, exactly one side wins.
    let updated = state
        .storage
        .update_message_metadata_trusted(request.id, patch, &[RequestStatus::Open.as_str()])
        .await?
        .ok_or_else(|| ApiError::Conflict("Payment request is no longer open".to_string()))?;

    let wire: MessageResponse = updated.into();
    if state.realtime_enabled && state.inline_realtime_publish {
        state
            .realtime_hub
            .publish_edited_wire(&request.group_id, wire.clone());
    }
    Ok(Json(wire))
}
