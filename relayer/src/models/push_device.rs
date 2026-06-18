//! Push device tokens and presence timestamps.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PushTokenRecord {
    pub wallet: String,
    pub platform: String,
    pub token: String,
    pub environment: String,
    pub updated_at: DateTime<Utc>,
}
