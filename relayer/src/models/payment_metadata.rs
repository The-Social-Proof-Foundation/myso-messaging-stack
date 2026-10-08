//! Cleartext, relayer-owned metadata for 1:1 DM payment messages.
//!
//! `token_transfer` and `request_payment` bodies (amount, asset, note) are encrypted
//! client-side. Only the fields below are cleartext so the relayer can verify a transfer
//! against the chain and enforce request state transitions.
//!
//! Clients never write `status` after create: the relayer sets it via the trusted
//! storage mutator (`update_message_metadata_trusted`).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

pub const PAYMENT_METADATA_VERSION: u32 = 1;

pub const TRANSFER_IDEMPOTENCY_PREFIX: &str = "transfer:";
pub const REQUEST_IDEMPOTENCY_PREFIX: &str = "request:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentAssetKind {
    Native,
    Spt,
}

impl PaymentAssetKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "native" => Some(Self::Native),
            "spt" => Some(Self::Spt),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Spt => "spt",
        }
    }
}

/// Status of a `token_transfer` message (chain-confirmed by the relayer).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferStatus {
    Pending,
    Success,
    Failed,
}

impl TransferStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Success => "success",
            Self::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(Self::Pending),
            "success" => Some(Self::Success),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// Status of a `request_payment` message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestStatus {
    Open,
    Rejected,
    Cancelled,
    Expired,
    /// A verified transfer was linked; the linked transfer carries Pending/Success/Failed.
    Paid,
}

impl RequestStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Rejected => "rejected",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
            Self::Paid => "paid",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Self::Open),
            "rejected" => Some(Self::Rejected),
            "cancelled" => Some(Self::Cancelled),
            "expired" => Some(Self::Expired),
            "paid" => Some(Self::Paid),
            _ => None,
        }
    }

    /// Terminal for payer/requester actions (a failed linked transfer may reopen `paid`).
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Rejected | Self::Cancelled | Self::Expired)
    }
}

/// Action a DM member may take on an open payment request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestAction {
    /// Payer declines.
    Reject,
    /// Requester withdraws.
    Cancel,
}

impl RequestAction {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "reject" => Some(Self::Reject),
            "cancel" => Some(Self::Cancel),
            _ => None,
        }
    }

    pub fn target_status(self) -> RequestStatus {
        match self {
            Self::Reject => RequestStatus::Rejected,
            Self::Cancel => RequestStatus::Cancelled,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaymentMetadataError {
    Missing,
    Invalid(String),
}

impl std::fmt::Display for PaymentMetadataError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing => f.write_str("metadata is required for this message kind"),
            Self::Invalid(msg) => f.write_str(msg),
        }
    }
}

/// Transaction digests are base58 of 32 bytes (43-44 chars).
pub fn is_valid_tx_digest(s: &str) -> bool {
    const B58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    (32..=44).contains(&s.len()) && s.chars().all(|c| B58.contains(c))
}

/// `transfer:<sender lowercase>:<digest>`. Scoped to the sender so nobody can front-run a
/// public digest and block the real sender's message via the global idempotency index.
pub fn transfer_idempotency_key(sender: &str, digest: &str) -> String {
    format!(
        "{TRANSFER_IDEMPOTENCY_PREFIX}{}:{digest}",
        sender.to_ascii_lowercase()
    )
}

fn str_field<'a>(meta: &'a Value, key: &str) -> Option<&'a str> {
    meta.get(key).and_then(Value::as_str).map(str::trim)
}

/// Lowercase `0x` + left-pad to 64 hex. `None` when not a valid address.
pub fn normalize_wallet(raw: &str) -> Option<String> {
    let lower = raw.trim().to_ascii_lowercase();
    let hex = lower.strip_prefix("0x")?;
    if hex.is_empty() || hex.len() > 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("0x{hex:0>64}"))
}

/// Validated create-time `token_transfer` input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenTransferCreate {
    pub digest: String,
    pub asset_kind: PaymentAssetKind,
    pub request_message_id: Option<Uuid>,
    /// Funded chain wallet that signed the transfer, when it differs from the messaging
    /// key (web zkLogin: the messaging key is ephemeral, the balance lives on the zk
    /// address). Client-asserted; see `services::transfer_confirmation` for the trade-off.
    pub sender_wallet: Option<String>,
}

/// Validates client-supplied metadata for `token_transfer`. Only the allowlisted fields are
/// read; everything else (including `status`, `to`) is derived or forced server-side.
pub fn parse_token_transfer_create(
    metadata: Option<&Value>,
    idempotency_key: Option<&str>,
    sender: &str,
) -> Result<TokenTransferCreate, PaymentMetadataError> {
    let meta = metadata.ok_or(PaymentMetadataError::Missing)?;
    let digest = str_field(meta, "digest")
        .ok_or_else(|| PaymentMetadataError::Invalid("metadata.digest is required".into()))?;
    if !is_valid_tx_digest(digest) {
        return Err(PaymentMetadataError::Invalid(
            "metadata.digest must be a base58 transaction digest".into(),
        ));
    }
    let asset_kind = str_field(meta, "asset_kind")
        .and_then(PaymentAssetKind::parse)
        .ok_or_else(|| {
            PaymentMetadataError::Invalid("metadata.asset_kind must be native or spt".into())
        })?;
    if let Some(status) = str_field(meta, "status") {
        if status != TransferStatus::Pending.as_str() {
            return Err(PaymentMetadataError::Invalid(
                "metadata.status must be pending on create".into(),
            ));
        }
    }
    let expected_key = transfer_idempotency_key(sender, digest);
    if idempotency_key != Some(expected_key.as_str()) {
        return Err(PaymentMetadataError::Invalid(format!(
            "idempotency_key must equal {expected_key}"
        )));
    }
    let request_message_id = match str_field(meta, "request_message_id") {
        None => None,
        Some(raw) => Some(Uuid::parse_str(raw).map_err(|_| {
            PaymentMetadataError::Invalid("metadata.request_message_id must be a UUID".into())
        })?),
    };
    let sender_wallet = match str_field(meta, "sender_wallet") {
        None => None,
        Some(raw) => Some(normalize_wallet(raw).ok_or_else(|| {
            PaymentMetadataError::Invalid("metadata.sender_wallet must be a 0x address".into())
        })?),
    };
    Ok(TokenTransferCreate {
        digest: digest.to_string(),
        asset_kind,
        request_message_id,
        sender_wallet,
    })
}

/// Canonical stored `token_transfer` metadata. `to` is the DM counterpart derived by the
/// relayer from membership (never client-supplied).
pub fn token_transfer_metadata(create: &TokenTransferCreate, to: &str) -> Value {
    let mut meta = json!({
        "version": PAYMENT_METADATA_VERSION,
        "digest": create.digest,
        "asset_kind": create.asset_kind.as_str(),
        "status": TransferStatus::Pending.as_str(),
        "to": to,
    });
    if let Some(id) = create.request_message_id {
        meta["request_message_id"] = json!(id.to_string());
    }
    if let Some(wallet) = &create.sender_wallet {
        meta["sender_wallet"] = json!(wallet);
    }
    meta
}

/// Validated create-time `request_payment` input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentRequestCreate {
    pub asset_kind: PaymentAssetKind,
}

pub fn parse_payment_request_create(
    metadata: Option<&Value>,
    idempotency_key: Option<&str>,
) -> Result<PaymentRequestCreate, PaymentMetadataError> {
    let meta = metadata.ok_or(PaymentMetadataError::Missing)?;
    let asset_kind = str_field(meta, "asset_kind")
        .and_then(PaymentAssetKind::parse)
        .ok_or_else(|| {
            PaymentMetadataError::Invalid("metadata.asset_kind must be native or spt".into())
        })?;
    if let Some(status) = str_field(meta, "status") {
        if status != RequestStatus::Open.as_str() {
            return Err(PaymentMetadataError::Invalid(
                "metadata.status must be open on create".into(),
            ));
        }
    }
    match idempotency_key {
        Some(k) if k.len() > REQUEST_IDEMPOTENCY_PREFIX.len() && k.starts_with(REQUEST_IDEMPOTENCY_PREFIX) => {}
        _ => {
            return Err(PaymentMetadataError::Invalid(format!(
                "idempotency_key must start with {REQUEST_IDEMPOTENCY_PREFIX}"
            )))
        }
    }
    Ok(PaymentRequestCreate { asset_kind })
}

/// Canonical stored `request_payment` metadata. `payer` is the DM counterpart.
pub fn payment_request_metadata(create: &PaymentRequestCreate, payer: &str) -> Value {
    json!({
        "version": PAYMENT_METADATA_VERSION,
        "asset_kind": create.asset_kind.as_str(),
        "payer": payer,
        "status": RequestStatus::Open.as_str(),
    })
}

pub fn metadata_status(meta: Option<&Value>) -> Option<&str> {
    meta.and_then(|m| m.get("status")).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST: &str = "5Hs8kmZjK9v7E2f1cQ3tYpLwNx4RbUaVd6GhTeJ8CqMn";
    const SENDER: &str = "0xabc123";

    #[test]
    fn digest_validation() {
        assert!(is_valid_tx_digest(DIGEST));
        assert!(!is_valid_tx_digest("short"));
        assert!(!is_valid_tx_digest(&"0".repeat(44))); // 0 is not base58
        assert!(!is_valid_tx_digest(&"A".repeat(45)));
    }

    #[test]
    fn transfer_create_requires_matching_idempotency_key() {
        let meta = json!({"digest": DIGEST, "asset_kind": "native", "status": "pending"});
        let key = transfer_idempotency_key(SENDER, DIGEST);
        let ok = parse_token_transfer_create(Some(&meta), Some(&key), SENDER).unwrap();
        assert_eq!(ok.asset_kind, PaymentAssetKind::Native);
        assert!(parse_token_transfer_create(Some(&meta), Some("transfer:other"), SENDER).is_err());
        assert!(parse_token_transfer_create(Some(&meta), None, SENDER).is_err());
        // Another sender cannot claim this sender's key.
        assert!(parse_token_transfer_create(Some(&meta), Some(&key), "0xother").is_err());
    }

    #[test]
    fn transfer_create_rejects_non_pending_status_and_bad_asset() {
        let key = transfer_idempotency_key(SENDER, DIGEST);
        let success = json!({"digest": DIGEST, "asset_kind": "native", "status": "success"});
        assert!(parse_token_transfer_create(Some(&success), Some(&key), SENDER).is_err());
        let bad_asset = json!({"digest": DIGEST, "asset_kind": "nft"});
        assert!(parse_token_transfer_create(Some(&bad_asset), Some(&key), SENDER).is_err());
        assert_eq!(
            parse_token_transfer_create(None, Some(&key), SENDER),
            Err(PaymentMetadataError::Missing)
        );
    }

    #[test]
    fn transfer_metadata_is_canonical_and_relayer_derived() {
        let key = transfer_idempotency_key(SENDER, DIGEST);
        let meta = json!({"digest": DIGEST, "asset_kind": "spt", "status": "pending", "to": "0xevil", "x": 1});
        let create = parse_token_transfer_create(Some(&meta), Some(&key), SENDER).unwrap();
        let stored = token_transfer_metadata(&create, "0xpeer");
        assert_eq!(stored["to"], "0xpeer");
        assert_eq!(stored["status"], "pending");
        assert!(stored.get("x").is_none());
    }

    #[test]
    fn transfer_create_validates_optional_sender_wallet() {
        let key = transfer_idempotency_key(SENDER, DIGEST);
        let ok = json!({"digest": DIGEST, "asset_kind": "native", "sender_wallet": "0xABC"});
        let create = parse_token_transfer_create(Some(&ok), Some(&key), SENDER).unwrap();
        assert_eq!(create.sender_wallet, Some(format!("0x{}abc", "0".repeat(61))));
        let stored = token_transfer_metadata(&create, "0xpeer");
        assert_eq!(stored["sender_wallet"], format!("0x{}abc", "0".repeat(61)));

        let bad = json!({"digest": DIGEST, "asset_kind": "native", "sender_wallet": "nothex"});
        assert!(parse_token_transfer_create(Some(&bad), Some(&key), SENDER).is_err());
    }

    #[test]
    fn request_create_forces_open_and_derives_payer() {
        let meta = json!({"asset_kind": "native", "payer": "0xevil"});
        let create = parse_payment_request_create(Some(&meta), Some("request:abc")).unwrap();
        let stored = payment_request_metadata(&create, "0xpeer");
        assert_eq!(stored["payer"], "0xpeer");
        assert_eq!(stored["status"], "open");
        assert!(parse_payment_request_create(Some(&meta), Some("nope")).is_err());
    }

    #[test]
    fn request_action_targets() {
        assert_eq!(RequestAction::Reject.target_status(), RequestStatus::Rejected);
        assert_eq!(RequestAction::Cancel.target_status(), RequestStatus::Cancelled);
        assert!(RequestAction::parse("confirm").is_none());
    }
}
