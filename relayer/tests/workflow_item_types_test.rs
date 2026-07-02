//! Workflow item type allowlist + FX5 ingest coverage + v1 chain lifecycle sync.

use messaging_relayer::models::workflow_item::{
    allowed_workflow_item_types, is_allowed_workflow_item_type, memory_access_idempotency_key,
    org_invitation_idempotency_key, WorkflowItemIngest, WorkflowTransitionPatch,
    ITEM_TYPE_ALERT, ITEM_TYPE_APPROVAL_REQUEST, ITEM_TYPE_GOVERNANCE_REQUEST,
    ITEM_TYPE_MEMORY_ACCESS_REQUEST, ITEM_TYPE_ORG_INVITATION, ITEM_TYPE_REMINDER,
    ITEM_TYPE_SCHEDULED_JOB_FAILURE, ITEM_TYPE_TASK, STATUS_ACTIONED, STATUS_EXPIRED,
    STATUS_OPEN,
};
use messaging_relayer::storage::{InMemoryWorkflowStore, WorkflowStore};
use serde_json::json;

#[test]
fn workflow_item_type_allowlist_includes_fx5_types() {
    let allowed = allowed_workflow_item_types();
    assert!(allowed.contains(&ITEM_TYPE_APPROVAL_REQUEST));
    assert!(allowed.contains(&ITEM_TYPE_ALERT));
    assert!(allowed.contains(&ITEM_TYPE_TASK));
    assert!(allowed.contains(&ITEM_TYPE_REMINDER));
    assert!(allowed.contains(&ITEM_TYPE_MEMORY_ACCESS_REQUEST));
    assert!(allowed.contains(&ITEM_TYPE_SCHEDULED_JOB_FAILURE));
    assert!(allowed.contains(&ITEM_TYPE_ORG_INVITATION));
    assert!(allowed.contains(&ITEM_TYPE_GOVERNANCE_REQUEST));
    assert!(!is_allowed_workflow_item_type("unknown_type"));
}

#[tokio::test]
async fn workflow_ingest_accepts_fx5_item_types() {
    let store = InMemoryWorkflowStore::new();
    let recipient = "0xowner".to_string();
    let cases: [(&str, String, serde_json::Value); 4] = [
        (
            ITEM_TYPE_TASK,
            "task:demo:1".to_string(),
            json!({ "assignee": "0xagent", "due_at_ms": 1_700_000_000_000_i64 }),
        ),
        (
            ITEM_TYPE_REMINDER,
            "reminder:demo:1".to_string(),
            json!({ "message": "Review pending approvals" }),
        ),
        (
            ITEM_TYPE_MEMORY_ACCESS_REQUEST,
            memory_access_idempotency_key("0xorg", "0xagent", 1),
            json!({
                "organization_id": "0xorg",
                "account_id": "0xaccount",
                "org_memory_group_id": "0xgroup",
                "member_address": "0xagent",
                "permissions_mask": 1,
            }),
        ),
        (
            ITEM_TYPE_SCHEDULED_JOB_FAILURE,
            "scheduled_job_failure:job:1".to_string(),
            json!({
                "job_id": "job-1",
                "run_id": "run-1",
                "error": "preflight rejected",
            }),
        ),
    ];

    for (item_type, idempotency_key, payload) in cases {
        let row = store
            .upsert_ingest(&WorkflowItemIngest {
                idempotency_key: idempotency_key.clone(),
                recipient_address: recipient.clone(),
                item_type: item_type.to_string(),
                title: format!("Test {item_type}"),
                body: None,
                payload,
                organization_id: Some("0xorg".to_string()),
                account_id: Some("0xaccount".to_string()),
                source_service: "test".to_string(),
                action_deadline_ms: None,
                conversation_ref: None,
            })
            .await
            .unwrap_or_else(|_| panic!("upsert failed for {item_type}"));
        assert_eq!(row.status, STATUS_OPEN);
        assert_eq!(row.item_type, item_type);
        assert_eq!(row.idempotency_key, idempotency_key);
    }
}

/// Wave 2.1 chain producer: `OrgInvitationCreated` idempotency key must be
/// stable so repeated ingest is safe and the accept/decline transitions can
/// locate the same row.
#[tokio::test]
async fn org_invitation_upsert_is_idempotent() {
    let store = InMemoryWorkflowStore::new();
    let key = org_invitation_idempotency_key("0xorg", "0xinvitee");
    let ingest = WorkflowItemIngest {
        idempotency_key: key.clone(),
        recipient_address: "0xinvitee".to_string(),
        item_type: ITEM_TYPE_ORG_INVITATION.to_string(),
        title: "Organization invitation".to_string(),
        body: None,
        payload: json!({
            "chain_event": "org_invitation_created",
            "organization_id": "0xorg",
            "invitee": "0xinvitee",
            "role_name": "member",
            "permissions_mask": 3,
        }),
        organization_id: Some("0xorg".to_string()),
        account_id: Some("0xaccount".to_string()),
        source_service: "membership_sync".to_string(),
        action_deadline_ms: Some(2_000_000_000_000),
        conversation_ref: None,
    };
    let first = store.upsert_ingest(&ingest).await.unwrap();
    let second = store.upsert_ingest(&ingest).await.unwrap();
    assert_eq!(first.id, second.id, "upsert must be stable on idempotency key");
    assert_eq!(second.status, STATUS_OPEN);
}

/// Wave 2.3 chain sync: an `OrgMemoryPermissionGranted` for the requested bit
/// closes the matching `memory_access_request` item.
#[tokio::test]
async fn memory_access_request_transitions_to_actioned_on_grant() {
    let store = InMemoryWorkflowStore::new();
    let mask = 1i64; // ORG_PERM_MEMORY_READ
    let key = memory_access_idempotency_key("0xorg", "0xagent", mask);
    store
        .upsert_ingest(&WorkflowItemIngest {
            idempotency_key: key.clone(),
            recipient_address: "0xowner".to_string(),
            item_type: ITEM_TYPE_MEMORY_ACCESS_REQUEST.to_string(),
            title: "Memory access requested".to_string(),
            body: None,
            payload: json!({ "member_address": "0xagent", "permissions_mask": mask }),
            organization_id: Some("0xorg".to_string()),
            account_id: Some("0xaccount".to_string()),
            source_service: "memory_relayer".to_string(),
            action_deadline_ms: None,
            conversation_ref: None,
        })
        .await
        .unwrap();

    let patch = WorkflowTransitionPatch {
        payload_patch: Some(json!({
            "chain_event": "org_memory_permission_granted",
            "granted_mask": mask,
        })),
        organization_id: Some("0xorg".to_string()),
    };
    let transitioned = store
        .transition_by_idempotency(&key, STATUS_ACTIONED, Some("0xadmin"), patch)
        .await
        .unwrap()
        .expect("memory_access_request should transition to actioned");
    assert_eq!(transitioned.status, STATUS_ACTIONED);
    assert_eq!(
        transitioned.actioned_by.as_deref(),
        Some("0xadmin"),
        "grant must record the granting admin"
    );
}

/// Wave 2.4 sweep: items past `action_deadline_ms` transition to `expired`.
#[tokio::test]
async fn org_invitation_expiry_sweep_transitions_past_deadline() {
    let store = InMemoryWorkflowStore::new();
    let now = chrono::Utc::now().timestamp_millis();
    let past = now - 60_000;
    let future = now + 60 * 60 * 1000;

    let past_key = org_invitation_idempotency_key("0xorg", "0xpast");
    let future_key = org_invitation_idempotency_key("0xorg", "0xfuture");

    for (idempotency_key, recipient, deadline) in [
        (past_key.clone(), "0xpast", past),
        (future_key.clone(), "0xfuture", future),
    ] {
        store
            .upsert_ingest(&WorkflowItemIngest {
                idempotency_key,
                recipient_address: recipient.to_string(),
                item_type: ITEM_TYPE_ORG_INVITATION.to_string(),
                title: "Organization invitation".to_string(),
                body: None,
                payload: json!({}),
                organization_id: Some("0xorg".to_string()),
                account_id: Some("0xaccount".to_string()),
                source_service: "membership_sync".to_string(),
                action_deadline_ms: Some(deadline),
                conversation_ref: None,
            })
            .await
            .unwrap();
    }

    let count = store
        .sweep_expired(ITEM_TYPE_ORG_INVITATION, now, 100)
        .await
        .unwrap();
    assert_eq!(count, 1, "sweep should only expire past-deadline items");

    let future_status = store
        .list_for_recipient("0xfuture", None, None, None, 10)
        .await
        .unwrap();
    assert_eq!(future_status.len(), 1);
    assert_eq!(future_status[0].status, STATUS_OPEN);

    let past_status = store
        .list_for_recipient("0xpast", None, None, None, 10)
        .await
        .unwrap();
    assert_eq!(past_status.len(), 1);
    assert_eq!(past_status[0].status, STATUS_EXPIRED);
}
