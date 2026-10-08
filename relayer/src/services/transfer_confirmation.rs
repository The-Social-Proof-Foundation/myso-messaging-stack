//! Chain confirmation for 1:1 DM `token_transfer` messages (and their linked requests).
//!
//! The client submits the transfer first and posts a `token_transfer` message carrying the
//! transaction digest. This service resolves that digest against the fullnode
//! (`LedgerService.GetTransaction`), verifies it, and flips the relayer-owned
//! `metadata.status` from `pending` to `success` / `failed` through the trusted storage
//! mutator. Clients never write status.
//!
//! Verification:
//! - the transaction sender must equal the message sender (so nobody can attach someone
//!   else's public digest to their own message and show "Success"). For web zkLogin the
//!   messaging key is ephemeral while the funds sit on the zk address, so the client may
//!   supply `metadata.sender_wallet`; that link is client-asserted (not proven), so on those
//!   sessions a user could display a third party's public transfer as their own. iOS and
//!   non-zkLogin web sessions are fully bound to the signing key;
//! - the transaction must have executed successfully;
//! - for SPT transfers a `TokenTransferredEvent { from == sender, to == DM peer }` must exist;
//! - for native transfers the DM peer must show a positive native-coin balance change. Native
//!   transfers emit no Move event, so without this any successful transaction by the sender
//!   (a dust self-transfer, say) would be displayed as a confirmed payment to the peer and
//!   would settle a payment request. When the fullnode reports no balance changes at all the
//!   recipient cannot be checked and the transfer falls back to sender-and-success only.
//!
//! The amount and asset are inside the encrypted body and are not verified by the relayer:
//! a transfer is confirmed as *a* payment to the peer, not as the requested amount.

use std::sync::OnceLock;
use std::time::Duration;

use chrono::Utc;
use myso_rpc::field::{FieldMask, FieldMaskUtil};
use myso_rpc::proto::myso::rpc::v2::ledger_service_client::LedgerServiceClient;
use myso_rpc::proto::myso::rpc::v2::GetTransactionRequest;
use serde_json::{json, Value};
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::handlers::messages::response::MessageResponse;
use crate::models::payment_metadata::{
    metadata_status, PaymentAssetKind, RequestStatus, TransferStatus,
};
use crate::models::{Message, MessageKind};
use crate::services::event_parser::{parse_token_transferred_event, TokenTransferredEvent};
use crate::state::AppState;

/// Attempts right after create (the tx may not be indexed on the fullnode yet).
const CREATE_ATTEMPTS: u32 = 5;
const CREATE_RETRY_DELAY: Duration = Duration::from_secs(2);
/// A digest the fullnode still cannot find after this long is marked failed.
const PENDING_GIVE_UP_SECS: i64 = 24 * 60 * 60;
/// Sweeper only picks up rows at least this old (fresh rows are handled inline).
const SWEEP_MIN_AGE_SECS: i64 = 20;
const SWEEP_BATCH: usize = 50;

#[derive(Debug, Clone)]
pub struct ConfirmationConfig {
    pub rpc_url: String,
    pub social_package_id: String,
}

static CONFIG: OnceLock<ConfirmationConfig> = OnceLock::new();

/// Called once from `server::run`. Without it (unit tests) confirmation is a no-op.
pub fn init(config: ConfirmationConfig) {
    let _ = CONFIG.set(config);
}

/// One balance change from a transaction's effects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BalanceDelta {
    pub address: String,
    pub coin_type: String,
    pub amount: i128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainOutcome {
    /// Fullnode does not know this digest (yet).
    NotFound,
    Executed {
        sender: String,
        success: bool,
        spt_transfers: Vec<TokenTransferredEvent>,
        balance_changes: Vec<BalanceDelta>,
    },
}

/// True for the native `0x2::myso::MYSO` coin, whatever padding the node uses for `0x2`.
pub fn is_native_coin(coin_type: &str) -> bool {
    let mut parts = coin_type.trim().split("::");
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(addr), Some("myso"), Some("MYSO"), None) => {
            normalize_address(addr) == normalize_address("0x2")
        }
        _ => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferExpectation {
    pub sender: String,
    pub to: String,
    pub asset_kind: PaymentAssetKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Success,
    Failed(&'static str),
}

/// Lowercase, 0x-prefixed, left-padded to 32 bytes so short and long forms compare equal.
pub fn normalize_address(addr: &str) -> String {
    let lower = addr.trim().to_ascii_lowercase();
    let hex = lower.strip_prefix("0x").unwrap_or(&lower);
    format!("0x{hex:0>64}")
}

/// Pure decision from chain data. `None` means "not decidable yet" (digest not found).
pub fn verdict_for(outcome: &ChainOutcome, expected: &TransferExpectation) -> Option<Verdict> {
    let (sender, success, spt_transfers, balance_changes) = match outcome {
        ChainOutcome::NotFound => return None,
        ChainOutcome::Executed {
            sender,
            success,
            spt_transfers,
            balance_changes,
        } => (sender, *success, spt_transfers, balance_changes),
    };
    let expected_sender = normalize_address(&expected.sender);
    if normalize_address(sender) != expected_sender {
        return Some(Verdict::Failed("sender_mismatch"));
    }
    if !success {
        return Some(Verdict::Failed("chain_failed"));
    }
    if expected.asset_kind == PaymentAssetKind::Spt {
        let expected_to = normalize_address(&expected.to);
        let matched = spt_transfers.iter().any(|t| {
            normalize_address(&t.from) == expected_sender && normalize_address(&t.to) == expected_to
        });
        if !matched {
            return Some(Verdict::Failed("event_mismatch"));
        }
    }
    if expected.asset_kind == PaymentAssetKind::Native && !balance_changes.is_empty() {
        let expected_to = normalize_address(&expected.to);
        let peer_received = balance_changes.iter().any(|b| {
            b.amount > 0
                && is_native_coin(&b.coin_type)
                && normalize_address(&b.address) == expected_to
        });
        if !peer_received {
            return Some(Verdict::Failed("recipient_mismatch"));
        }
    }
    Some(Verdict::Success)
}

/// Looks the digest up on the fullnode.
pub async fn fetch_chain_outcome(
    config: &ConfirmationConfig,
    digest: &str,
) -> Result<ChainOutcome, String> {
    let mut client = LedgerServiceClient::connect(config.rpc_url.clone())
        .await
        .map_err(|e| e.to_string())?;

    let mut request = GetTransactionRequest::default();
    request.digest = Some(digest.to_string());
    request.read_mask = Some(FieldMask::from_str(
        "digest,transaction.sender,effects.status,events,balance_changes",
    ));

    let response = match client.get_transaction(request).await {
        Ok(r) => r.into_inner(),
        // tonic::Code::NotFound == 5 (tonic is only a dev-dependency of this crate).
        Err(status) if status.code() as i32 == 5 => return Ok(ChainOutcome::NotFound),
        Err(status) => return Err(status.to_string()),
    };
    let Some(tx) = response.transaction else {
        return Ok(ChainOutcome::NotFound);
    };

    let sender = tx
        .transaction
        .as_ref()
        .and_then(|t| t.sender.clone())
        .unwrap_or_default();
    let success = tx
        .effects
        .as_ref()
        .and_then(|e| e.status.as_ref())
        .and_then(|s| s.success)
        .unwrap_or(false);
    let spt_transfers: Vec<TokenTransferredEvent> = tx
        .events
        .as_ref()
        .map(|events| {
            events
                .events
                .iter()
                .filter_map(|e| parse_token_transferred_event(e, &config.social_package_id))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let balance_changes: Vec<BalanceDelta> = tx
        .balance_changes
        .iter()
        .filter_map(|b| {
            Some(BalanceDelta {
                address: b.address.clone()?,
                coin_type: b.coin_type.clone()?,
                amount: b.amount.as_deref()?.trim().parse().ok()?,
            })
        })
        .collect();

    Ok(ChainOutcome::Executed {
        sender,
        success,
        spt_transfers,
        balance_changes,
    })
}

fn publish_edited(state: &AppState, message: &Message) {
    if state.realtime_enabled && state.inline_realtime_publish {
        let wire: MessageResponse = message.clone().into();
        state
            .realtime_hub
            .publish_edited_wire(&message.group_id, wire);
    }
}

fn meta_str<'a>(message: &'a Message, key: &str) -> Option<&'a str> {
    message
        .metadata
        .as_ref()
        .and_then(|m| m.get(key))
        .and_then(Value::as_str)
}

/// True when `request_message_id` points at an open request in this group whose payer is `sender`.
pub async fn request_link_is_valid(
    state: &AppState,
    group_id: &str,
    sender: &str,
    request_message_id: Uuid,
) -> bool {
    let Ok(request) = state.storage.get_message(request_message_id).await else {
        return false;
    };
    request.kind == MessageKind::RequestPayment
        && request.group_id == group_id
        && metadata_status(request.metadata.as_ref()) == Some(RequestStatus::Open.as_str())
        && meta_str(&request, "payer")
            .is_some_and(|payer| normalize_address(payer) == normalize_address(sender))
}

/// open -> paid, linking the fulfilling transfer. First valid transition wins (CAS).
pub async fn mark_request_paid(
    state: &AppState,
    request_message_id: Uuid,
    transfer_message_id: Uuid,
    digest: &str,
) {
    let patch = json!({
        "status": RequestStatus::Paid.as_str(),
        "fulfilling_message_id": transfer_message_id.to_string(),
        "fulfilled_digest": digest,
    });
    match state
        .storage
        .update_message_metadata_trusted(request_message_id, patch, &[RequestStatus::Open.as_str()])
        .await
    {
        Ok(Some(updated)) => publish_edited(state, &updated),
        Ok(None) => warn!(
            request = %request_message_id,
            transfer = %transfer_message_id,
            "payment request already resolved; transfer message stays unlinked"
        ),
        Err(e) => warn!("failed to link payment request {request_message_id}: {e}"),
    }
}

/// paid -> open when the fulfilling transfer failed, so the payer can try again.
async fn reopen_request_if_linked(state: &AppState, transfer: &Message) {
    let Some(request_id) = meta_str(transfer, "request_message_id").and_then(|s| Uuid::parse_str(s).ok())
    else {
        return;
    };
    let Ok(request) = state.storage.get_message(request_id).await else {
        return;
    };
    if meta_str(&request, "fulfilling_message_id") != Some(transfer.id.to_string().as_str()) {
        return;
    }
    let patch = json!({
        "status": RequestStatus::Open.as_str(),
        "fulfilling_message_id": Value::Null,
        "fulfilled_digest": Value::Null,
    });
    match state
        .storage
        .update_message_metadata_trusted(request_id, patch, &[RequestStatus::Paid.as_str()])
        .await
    {
        Ok(Some(updated)) => publish_edited(state, &updated),
        Ok(None) => {}
        Err(e) => warn!("failed to reopen payment request {request_id}: {e}"),
    }
}

/// Applies a verdict (pending -> success|failed). Returns true when the row is resolved.
async fn apply_verdict(state: &AppState, message: &Message, verdict: Verdict) -> bool {
    let patch = match &verdict {
        Verdict::Success => json!({ "status": TransferStatus::Success.as_str() }),
        Verdict::Failed(reason) => json!({
            "status": TransferStatus::Failed.as_str(),
            "reason": reason,
        }),
    };
    match state
        .storage
        .update_message_metadata_trusted(message.id, patch, &[TransferStatus::Pending.as_str()])
        .await
    {
        Ok(Some(updated)) => {
            info!(message = %updated.id, ?verdict, "token transfer resolved");
            publish_edited(state, &updated);
            if matches!(verdict, Verdict::Failed(_)) {
                reopen_request_if_linked(state, &updated).await;
            }
            true
        }
        // Already resolved by another path.
        Ok(None) => true,
        Err(e) => {
            warn!("failed to update token transfer {}: {e}", message.id);
            false
        }
    }
}

/// One resolution attempt. Returns true when resolved (or nothing to do).
async fn resolve_once(state: &AppState, config: &ConfirmationConfig, message: &Message) -> bool {
    if message.kind != MessageKind::TokenTransfer
        || metadata_status(message.metadata.as_ref()) != Some(TransferStatus::Pending.as_str())
    {
        return true;
    }
    let (Some(digest), Some(to), Some(asset_kind)) = (
        meta_str(message, "digest"),
        meta_str(message, "to"),
        meta_str(message, "asset_kind").and_then(PaymentAssetKind::parse),
    ) else {
        warn!(message = %message.id, "token transfer is missing metadata; marking failed");
        return apply_verdict(state, message, Verdict::Failed("bad_metadata")).await;
    };

    let outcome = match fetch_chain_outcome(config, digest).await {
        Ok(o) => o,
        Err(e) => {
            warn!(digest, "fullnode lookup failed: {e}");
            return false;
        }
    };
    let expected = TransferExpectation {
        sender: meta_str(message, "sender_wallet")
            .unwrap_or(message.sender_wallet_addr.as_str())
            .to_string(),
        to: to.to_string(),
        asset_kind,
    };
    match verdict_for(&outcome, &expected) {
        Some(verdict) => apply_verdict(state, message, verdict).await,
        None => {
            let age_secs = (Utc::now() - message.created_at).num_seconds();
            if age_secs > PENDING_GIVE_UP_SECS {
                apply_verdict(state, message, Verdict::Failed("not_found")).await
            } else {
                false
            }
        }
    }
}

/// Runs right after a `token_transfer` is created: a few quick retries, then the sweeper
/// takes over.
pub async fn confirm_transfer_message(state: &AppState, message: Message) {
    let Some(config) = CONFIG.get() else {
        debug!("transfer confirmation not configured; leaving message pending");
        return;
    };
    for attempt in 0..CREATE_ATTEMPTS {
        if resolve_once(state, config, &message).await {
            return;
        }
        if attempt + 1 < CREATE_ATTEMPTS {
            tokio::time::sleep(CREATE_RETRY_DELAY).await;
        }
    }
}

/// Periodic sweep for transfers still `pending` (relayer restarts, slow indexing).
pub async fn run_confirmation_sweep(state: AppState, interval_secs: u64) {
    let Some(config) = CONFIG.get() else {
        return;
    };
    let interval_secs = interval_secs.max(10);
    info!(interval_secs, "token transfer confirmation sweep started");
    let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let cutoff = Utc::now() - chrono::Duration::seconds(SWEEP_MIN_AGE_SECS);
        match state
            .storage
            .list_pending_token_transfers(cutoff, SWEEP_BATCH)
            .await
        {
            Ok(rows) => {
                for message in rows {
                    resolve_once(&state, config, &message).await;
                }
            }
            Err(e) => warn!("pending token transfer sweep failed: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SENDER: &str = "0xabc";
    const PEER: &str = "0xdef";

    fn expected(asset_kind: PaymentAssetKind) -> TransferExpectation {
        TransferExpectation {
            sender: SENDER.into(),
            to: PEER.into(),
            asset_kind,
        }
    }

    fn executed(sender: &str, success: bool, spt: Vec<TokenTransferredEvent>) -> ChainOutcome {
        ChainOutcome::Executed {
            sender: sender.into(),
            success,
            spt_transfers: spt,
            balance_changes: vec![],
        }
    }

    fn executed_with_balances(sender: &str, balances: Vec<BalanceDelta>) -> ChainOutcome {
        ChainOutcome::Executed {
            sender: sender.into(),
            success: true,
            spt_transfers: vec![],
            balance_changes: balances,
        }
    }

    fn delta(address: &str, coin_type: &str, amount: i128) -> BalanceDelta {
        BalanceDelta {
            address: address.into(),
            coin_type: coin_type.into(),
            amount,
        }
    }

    fn spt_event(from: &str, to: &str) -> TokenTransferredEvent {
        TokenTransferredEvent {
            pool_id: "0x1".into(),
            from: from.into(),
            to: to.into(),
            amount: 1,
        }
    }

    #[test]
    fn address_normalization_pads_and_lowercases() {
        assert_eq!(normalize_address("0xAB"), format!("0x{}ab", "0".repeat(62)));
        assert_eq!(normalize_address("0xab"), normalize_address("AB"));
    }

    #[test]
    fn not_found_is_undecided() {
        assert_eq!(
            verdict_for(&ChainOutcome::NotFound, &expected(PaymentAssetKind::Native)),
            None
        );
    }

    #[test]
    fn native_success_requires_matching_sender() {
        let ok = executed("0xABC", true, vec![]);
        assert_eq!(
            verdict_for(&ok, &expected(PaymentAssetKind::Native)),
            Some(Verdict::Success)
        );
        let wrong = executed("0x999", true, vec![]);
        assert_eq!(
            verdict_for(&wrong, &expected(PaymentAssetKind::Native)),
            Some(Verdict::Failed("sender_mismatch"))
        );
    }

    #[test]
    fn failed_execution_is_failed() {
        let failed = executed(SENDER, false, vec![]);
        assert_eq!(
            verdict_for(&failed, &expected(PaymentAssetKind::Native)),
            Some(Verdict::Failed("chain_failed"))
        );
    }

    #[test]
    fn native_coin_type_is_recognised_with_any_padding() {
        assert!(is_native_coin("0x2::myso::MYSO"));
        assert!(is_native_coin(&format!("0x{}2::myso::MYSO", "0".repeat(63))));
        assert!(!is_native_coin("0x2::myso::OTHER"));
        assert!(!is_native_coin("0x3::myso::MYSO"));
        assert!(!is_native_coin("0x2::coin::Coin<0x2::myso::MYSO>"));
        assert!(!is_native_coin(""));
    }

    #[test]
    fn native_transfer_must_credit_the_peer() {
        let exp = expected(PaymentAssetKind::Native);
        // Sender paid gas and nothing reached the peer: a dust self-transfer must not
        // be shown as a confirmed payment.
        let nothing_to_peer = executed_with_balances(
            SENDER,
            vec![delta(SENDER, "0x2::myso::MYSO", -1_000)],
        );
        assert_eq!(
            verdict_for(&nothing_to_peer, &exp),
            Some(Verdict::Failed("recipient_mismatch"))
        );

        let credited = executed_with_balances(
            SENDER,
            vec![
                delta(SENDER, "0x2::myso::MYSO", -5_000),
                delta("0xDEF", "0x2::myso::MYSO", 4_000),
            ],
        );
        assert_eq!(verdict_for(&credited, &exp), Some(Verdict::Success));
    }

    #[test]
    fn native_transfer_ignores_other_coins_and_negative_deltas() {
        let exp = expected(PaymentAssetKind::Native);
        let worthless_coin = executed_with_balances(
            SENDER,
            vec![delta(PEER, "0xabc::junk::JUNK", 1_000_000)],
        );
        assert_eq!(
            verdict_for(&worthless_coin, &exp),
            Some(Verdict::Failed("recipient_mismatch"))
        );

        let peer_lost_funds =
            executed_with_balances(SENDER, vec![delta(PEER, "0x2::myso::MYSO", -1)]);
        assert_eq!(
            verdict_for(&peer_lost_funds, &exp),
            Some(Verdict::Failed("recipient_mismatch"))
        );
    }

    #[test]
    fn native_transfer_falls_back_when_the_node_reports_no_balance_changes() {
        // A successful transaction always has at least a gas change, so an empty list
        // means the node did not provide the data. Failing every payment for that would
        // be worse than the pre-existing sender-and-success check.
        let unknown = executed_with_balances(SENDER, vec![]);
        assert_eq!(
            verdict_for(&unknown, &expected(PaymentAssetKind::Native)),
            Some(Verdict::Success)
        );
    }

    #[test]
    fn spt_requires_matching_event() {
        let exp = expected(PaymentAssetKind::Spt);
        let none = executed(SENDER, true, vec![]);
        assert_eq!(verdict_for(&none, &exp), Some(Verdict::Failed("event_mismatch")));

        let wrong_to = executed(SENDER, true, vec![spt_event(SENDER, "0x777")]);
        assert_eq!(
            verdict_for(&wrong_to, &exp),
            Some(Verdict::Failed("event_mismatch"))
        );

        let good = executed(SENDER, true, vec![spt_event("0xABC", "0xDEF")]);
        assert_eq!(verdict_for(&good, &exp), Some(Verdict::Success));
    }
}
