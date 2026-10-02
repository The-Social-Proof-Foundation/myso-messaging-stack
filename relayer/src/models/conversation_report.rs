//! Metadata-only conversation report.
//!
//! Stores who reported, which chat, the optional peer wallet, when, and why.
//! Message plaintext and ciphertext are never fields on this record.

use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ConversationReport {
    pub id: Uuid,
    pub reporter: String,
    pub group_id: String,
    pub reported_wallet: Option<String>,
    pub reason: String,
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
}
