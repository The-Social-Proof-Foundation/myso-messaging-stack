//! Opaque encrypted read-state blob stored per wallet.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncryptedBlobRecord {
    pub encrypted_blob: Vec<u8>,
    pub blob_version: u64,
    pub updated_at: DateTime<Utc>,
}
