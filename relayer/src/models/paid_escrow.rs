//! Paid DM escrow record mirrored from on-chain `message_log::PaidMessageSent` events.

/// One on-chain paid-message escrow, keyed by `(group_id, seq)`.
///
/// `seq` is the on-chain `MessageLog.next_seq` value at send time, so replays of
/// the same checkpoint upsert rather than duplicate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaidEscrowRecord {
    pub group_id: String,
    pub seq: i64,
    pub payer: String,
    pub recipient: String,
    /// Escrowed MYSO amount. On-chain u64, clamped to i64 for storage.
    pub amount: i64,
    pub created_at_ms: i64,
}
