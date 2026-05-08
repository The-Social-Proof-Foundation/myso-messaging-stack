//! Off-chain mirror of group-level features (reactions, pins, receipts) for `/v1` APIs.
//! This is complementary to the on-chain `MessageLog` and is relayer-local.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ReactionEntry {
    pub chain_seq: i64,
    pub emoji_code: u32,
    pub count: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReceiptStateResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_upto: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_upto: Option<u64>,
}
