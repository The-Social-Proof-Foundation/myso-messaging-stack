//! Off-chain mirror of group-level features (reactions, pins, receipts) for `/v1` APIs.
//! This is complementary to the on-chain `MessageLog` and is relayer-local.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ReactionEntry {
    pub chain_seq: i64,
    /// Canonical Unicode emoji string (NFC) — supports skin tones, ZWJ
    /// sequences, and variation selectors.
    pub emoji: String,
    pub count: i32,
    /// Wallet addresses of members who currently have this reaction set.
    pub reactors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReceiptStateResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_upto: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_upto: Option<u64>,
}

/// Aggregate message activity for a group: the highest assigned order and the
/// count of non-deleted messages after a client-supplied watermark.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupActivity {
    /// Highest `order` assigned in the group (0 when empty). Includes
    /// soft-deleted messages — order assignment is monotonic.
    pub latest_order: i64,
    /// Count of non-deleted messages with `order > after_order`.
    pub unread_count: i64,
}
