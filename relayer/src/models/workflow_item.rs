//! Workflow inbox item model (metadata-only payloads; not E2E chat).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const ITEM_TYPE_APPROVAL_REQUEST: &str = "approval_request";
pub const ITEM_TYPE_ALERT: &str = "alert";
pub const ITEM_TYPE_TASK: &str = "task";
pub const ITEM_TYPE_REMINDER: &str = "reminder";
pub const ITEM_TYPE_MEMORY_ACCESS_REQUEST: &str = "memory_access_request";
pub const ITEM_TYPE_SCHEDULED_JOB_FAILURE: &str = "scheduled_job_failure";
pub const ITEM_TYPE_ORG_INVITATION: &str = "org_invitation";
pub const ITEM_TYPE_GOVERNANCE_REQUEST: &str = "governance_request";

/// All ingestible workflow item types (v1 + FX5 + FX2 extensions).
pub fn allowed_workflow_item_types() -> &'static [&'static str] {
    &[
        ITEM_TYPE_APPROVAL_REQUEST,
        ITEM_TYPE_ALERT,
        ITEM_TYPE_TASK,
        ITEM_TYPE_REMINDER,
        ITEM_TYPE_MEMORY_ACCESS_REQUEST,
        ITEM_TYPE_SCHEDULED_JOB_FAILURE,
        ITEM_TYPE_ORG_INVITATION,
        ITEM_TYPE_GOVERNANCE_REQUEST,
    ]
}

pub fn is_allowed_workflow_item_type(item_type: &str) -> bool {
    allowed_workflow_item_types().contains(&item_type)
}

pub const STATUS_OPEN: &str = "open";
pub const STATUS_ACTIONED: &str = "actioned";
pub const STATUS_DISMISSED: &str = "dismissed";
pub const STATUS_EXPIRED: &str = "expired";

/// Shared with the oracle workflow ingest client and chain lifecycle sync.
pub fn approval_idempotency_key(balance_id: &str, agent_object_id: &str) -> String {
    format!("approval:{balance_id}:{agent_object_id}")
}

/// Shared with the social-server memory access workflow ingest client and chain lifecycle sync.
pub fn memory_access_idempotency_key(
    organization_id: &str,
    member_address: &str,
    permissions_mask: i64,
) -> String {
    format!("memory_access:{organization_id}:{member_address}:{permissions_mask}")
}

/// Shared with org invitation workflow ingest and chain lifecycle sync.
pub fn org_invitation_idempotency_key(organization_id: &str, invitee_address: &str) -> String {
    format!("org_invitation:{organization_id}:{invitee_address}")
}

/// Shared with governance request workflow ingest and chain lifecycle sync.
pub fn governance_request_idempotency_key(organization_id: &str, proposal_id: &str) -> String {
    format!("governance_request:{organization_id}:{proposal_id}")
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
