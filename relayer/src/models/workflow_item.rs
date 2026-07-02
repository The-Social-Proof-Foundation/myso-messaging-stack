//! Workflow inbox item model (metadata-only payloads; not E2E chat).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const ITEM_TYPE_APPROVAL_REQUEST: &str = "approval_request";
pub const ITEM_TYPE_ALERT: &str = "alert";

pub const STATUS_OPEN: &str = "open";
pub const STATUS_ACTIONED: &str = "actioned";
pub const STATUS_DISMISSED: &str = "dismissed";
pub const STATUS_EXPIRED: &str = "expired";

/// Shared with the oracle workflow ingest client and chain lifecycle sync.
pub fn approval_idempotency_key(balance_id: &str, agent_object_id: &str) -> String {
    format!("approval:{balance_id}:{agent_object_id}")
}

/// Optional metadata applied when a chain event transitions an open workflow item.
#[derive(Debug, Clone, Default)]
pub struct WorkflowTransitionPatch {
    /// Merged into the item payload (chain lifecycle fields for clients).
    pub payload_patch: Option<serde_json::Value>,
    /// Set when the chain event carries org attribution and the row has none yet.
    pub organization_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowItem {
    pub id: Uuid,
    pub idempotency_key: String,
    pub recipient_address: String,
    pub item_type: String,
    pub status: String,
    pub title: String,
    pub body: Option<String>,
    pub payload: serde_json::Value,
    pub organization_id: Option<String>,
    pub account_id: Option<String>,
    pub source_service: String,
    pub action_deadline_ms: Option<i64>,
    pub conversation_ref: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub actioned_by: Option<String>,
    pub actioned_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkflowItemIngest {
    pub idempotency_key: String,
    pub recipient_address: String,
    pub item_type: String,
    pub title: String,
    pub body: Option<String>,
    #[serde(default)]
    pub payload: serde_json::Value,
    pub organization_id: Option<String>,
    pub account_id: Option<String>,
    pub source_service: String,
    pub action_deadline_ms: Option<i64>,
    pub conversation_ref: Option<String>,
}
