//! Paid-DM gate: shared evaluation used by `POST /messages` enforcement, plus the
//! advisory `GET /v1/messaging/dm-gate` endpoint (wallet auth).
//!
//! Mirrors on-chain `messaging::assert_paid_open_allowed` for free-message delivery:
//! the gate only applies to a conversation nobody has opened yet (on-chain
//! `next_seq == 0` semantics). A first outbound message from a non-follower into a
//! 1:1 DM whose recipient has paid messaging enabled requires an indexed
//! `PaidMessageSent` escrow — but replies are always free: once the peer has paid
//! the sender (or has any stored message in the group), the conversation is open
//! and the reply must not be charged.

use axum::extract::{Query, State};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use crate::auth::AuthContext;
use crate::handlers::messages::error::ApiError;
use crate::state::AppState;

/// Gate decision detail. All checks are idempotent state reads (payment exists /
/// follow edge / policy), so concurrent sends race-free evaluate to the same result.
#[derive(Debug, Clone)]
pub struct PaidDmGate {
    /// No prior stored message from this sender in the group (per-sender, NOT
    /// total conversation count). True when no group is given (pre-create check).
    pub first_outbound: bool,
    /// An indexed on-chain escrow exists from sender (or principal) to recipient.
    pub paid: bool,
    /// An indexed on-chain escrow exists from the recipient to the sender (or
    /// principal): the peer opened this conversation as a paid DM, so the
    /// sender's reply is free (and claims the escrow on-chain when replied to).
    pub peer_paid: bool,
    /// Latest escrowed amount behind `peer_paid`, for "reply to claim" UX.
    pub peer_escrow_amount: Option<u64>,
    /// The recipient already has a stored message in this group — the
    /// conversation is open, so the sender's message is a reply, never gated.
    pub peer_has_messaged: bool,
    /// Sender's social identity follows the recipient. `None` when the evaluation
    /// short-circuited before the follow lookup.
    pub following: Option<bool>,
    /// Recipient's required minimum escrow (policy enabled + min set), else `None`.
    pub min_cost: Option<u64>,
    /// Final decision: the free message must be rejected with 402.
    pub payment_required: bool,
}

/// Evaluates the paid-DM gate for `sender` messaging `recipient`.
///
/// - `group_id`: group scope for first-outbound + escrow checks; `None` for
///   pre-create advisory checks (treated as first message, unpaid).
/// - `principal_owner`: agent messages evaluate the follow graph against the
///   human principal (mirrors on-chain `send_agent_paid_message_digest`) and
///   accept escrows paid by either actor or principal.
/// - `full`: compute every field for the advisory endpoint; when false the
///   evaluation short-circuits as soon as the gate is known to pass (skips
///   social-server calls on the hot path).
///
/// Ordering is cheap-to-expensive: local DB (first outbound, escrow) before
/// cached social-server HTTP (follow, policy). Social-server failures map to
/// 500 — fail closed, same as the block check.
pub async fn evaluate_paid_dm_gate(
    state: &AppState,
    group_id: Option<&str>,
    sender: &str,
    principal_owner: Option<&str>,
    recipient: &str,
    full: bool,
) -> Result<PaidDmGate, ApiError> {
    let mut gate = PaidDmGate {
        first_outbound: true,
        paid: false,
        peer_paid: false,
        peer_escrow_amount: None,
        peer_has_messaged: false,
        following: None,
        min_cost: None,
        payment_required: false,
    };

    if let Some(gid) = group_id {
        gate.first_outbound = !state.storage.has_message_from(gid, sender).await?;

        // Hot path: any prior outbound message from this sender means the gate
        // cannot apply — skip the remaining state reads entirely.
        if !full && !gate.first_outbound {
            return Ok(gate);
        }

        // The contract enforced the recipient's minimum at open time, so escrow
        // existence (min_amount = 0) is sufficient — a later policy increase must
        // not re-lock an already-opened conversation.
        gate.paid = state
            .storage
            .has_paid_escrow(gid, sender, recipient, 0)
            .await?;
        if !gate.paid {
            if let Some(principal) = principal_owner {
                gate.paid = state
                    .storage
                    .has_paid_escrow(gid, principal, recipient, 0)
                    .await?;
            }
        }

        // Reply exemption: the peer opened this conversation, either by paying
        // the sender (or principal) or by having a stored message in the group.
        // Mirrors on-chain `next_seq != 0`: replies are never charged.
        let mut peer_amount = state
            .storage
            .latest_paid_escrow_amount(gid, recipient, sender)
            .await?;
        if peer_amount.is_none() {
            if let Some(principal) = principal_owner {
                peer_amount = state
                    .storage
                    .latest_paid_escrow_amount(gid, recipient, principal)
                    .await?;
            }
        }
        gate.peer_paid = peer_amount.is_some();
        gate.peer_escrow_amount = peer_amount.map(|a| a.max(0) as u64);

        gate.peer_has_messaged = state.storage.has_message_from(gid, recipient).await?;
    }

    if !full && (gate.paid || gate.peer_paid || gate.peer_has_messaged) {
        return Ok(gate);
    }

    // The human whose follow graph applies: principal for agent senders.
    let social_identity = principal_owner.unwrap_or(sender);
    let following = state
        .message_gate
        .is_following(social_identity, recipient)
        .await
        .map_err(|e| ApiError::Internal(format!("Paid-DM gate unavailable: {}", e)))?;
    gate.following = Some(following);

    if !full && following {
        return Ok(gate);
    }

    let policy = state
        .message_gate
        .paid_policy(recipient)
        .await
        .map_err(|e| ApiError::Internal(format!("Paid-DM gate unavailable: {}", e)))?;
    gate.min_cost = policy.and_then(|p| p.required_min_cost());

    gate.payment_required = gate.first_outbound
        && !gate.paid
        && !gate.peer_paid
        && !gate.peer_has_messaged
        && !following
        && gate.min_cost.is_some();
    Ok(gate)
}

#[derive(Debug, Deserialize)]
pub struct DmGateQuery {
    /// Recipient wallet address.
    pub recipient: String,
    /// Optional group scope; omit for pre-create checks.
    pub group_id: Option<String>,
}

/// Advisory gate response. `reason` is an extensible enum (`BLOCKED`,
/// `PAYMENT_REQUIRED`, …) so future gates never change client semantics.
/// `POST /messages` remains the authoritative enforcement point.
#[derive(Debug, Serialize)]
pub struct DmGateResponse {
    pub allowed: bool,
    pub reason: Option<String>,
    pub blocked: bool,
    pub following: bool,
    pub paid: bool,
    /// No prior outbound message from the caller in this group. Combined with
    /// `peer_paid`, clients can show "reply to claim" prompts.
    pub first_outbound: bool,
    /// The peer already escrowed MYSO to the caller in this group — replying
    /// is free and claims the escrow on-chain.
    pub peer_paid: bool,
    /// Latest peer escrow amount (MIST) as a string, when `peer_paid` is true.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_escrow_amount: Option<String>,
    /// Minimum escrow (MIST) as a string, when payment applies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_cost: Option<String>,
    pub recipient: String,
}

const REASON_BLOCKED: &str = "BLOCKED";
const REASON_PAYMENT_REQUIRED: &str = "PAYMENT_REQUIRED";

/// GET /v1/messaging/dm-gate?recipient=0x…&group_id=0x…
///
/// Sender is the wallet-authenticated caller. Advisory only — lets clients show
/// a payment dialog before a send fails with 402.
pub async fn get_dm_gate(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Query(query): Query<DmGateQuery>,
) -> Result<Json<DmGateResponse>, ApiError> {
    let sender = auth.sender_address.as_str();
    let recipient = query.recipient.trim();
    if recipient.is_empty() {
        return Err(ApiError::BadRequest("recipient is required".to_string()));
    }

    if recipient == sender {
        return Ok(Json(DmGateResponse {
            allowed: true,
            reason: None,
            blocked: false,
            following: false,
            paid: false,
            first_outbound: false,
            peer_paid: false,
            peer_escrow_amount: None,
            min_cost: None,
            recipient: recipient.to_string(),
        }));
    }

    let blocked = if state.block_check.is_enabled() {
        state
            .block_check
            .check_either_blocked(sender, recipient)
            .await
            .map_err(|e| ApiError::Internal(format!("Block check unavailable: {}", e)))?
    } else {
        false
    };

    let gate = evaluate_paid_dm_gate(
        &state,
        query.group_id.as_deref(),
        sender,
        None,
        recipient,
        true,
    )
    .await?;

    let reason = if blocked {
        Some(REASON_BLOCKED.to_string())
    } else if gate.payment_required {
        Some(REASON_PAYMENT_REQUIRED.to_string())
    } else {
        None
    };

    Ok(Json(DmGateResponse {
        allowed: reason.is_none(),
        reason,
        blocked,
        following: gate.following.unwrap_or(false),
        paid: gate.paid,
        first_outbound: gate.first_outbound,
        peer_paid: gate.peer_paid,
        peer_escrow_amount: gate.peer_escrow_amount.map(|a| a.to_string()),
        min_cost: gate.min_cost.map(|c| c.to_string()),
        recipient: recipient.to_string(),
    }))
}
