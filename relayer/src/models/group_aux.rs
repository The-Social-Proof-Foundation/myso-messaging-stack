//! Off-chain mirror of group-level features (reactions, pins, receipts) for `/v1` APIs.
//! This is complementary to the on-chain `MessageLog` and is relayer-local.

use serde::{Deserialize, Serialize};

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

/// One member's peer-visible delivery/read watermarks in a group.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemberReceipt {
    pub member: String,
    pub delivered_upto: u64,
    pub read_upto: u64,
}

/// `GET /v1/groups/:id/receipts` — all members' watermarks (membership-gated).
#[derive(Debug, Clone, Serialize)]
pub struct GroupReceiptsResponse {
    pub members: Vec<MemberReceipt>,
}

/// Legacy single-member shape (kept for tests / transitional callers).
#[derive(Debug, Clone, Serialize)]
pub struct ReceiptStateResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_upto: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_upto: Option<u64>,
}

/// Per-member conversation preferences (`GET/PUT /v1/groups/:id/prefs`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationPreferences {
    pub notification_mode: String,
    pub receipt_mode: String,
    /// When true, peers must not see this wallet as Online in this group.
    pub hide_online_presence: bool,
    pub version: i32,
}

impl ConversationPreferences {
    pub fn defaults() -> Self {
        Self {
            notification_mode: "all".to_string(),
            receipt_mode: "full".to_string(),
            hide_online_presence: false,
            version: 1,
        }
    }
}

/// Partial patch for `PUT /v1/groups/:id/prefs` (omitted fields preserved).
#[derive(Debug, Clone, Default)]
pub struct ConversationPreferencesPatch {
    pub notification_mode: Option<String>,
    pub receipt_mode: Option<String>,
    pub hide_online_presence: Option<bool>,
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
