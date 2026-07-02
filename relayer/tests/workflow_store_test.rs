//! Workflow inbox store tests (memory backend).

use messaging_relayer::models::workflow_item::{
    approval_idempotency_key, WorkflowItemIngest, WorkflowTransitionPatch,
    ITEM_TYPE_APPROVAL_REQUEST, STATUS_ACTIONED, STATUS_OPEN,
};
use messaging_relayer::storage::{InMemoryWorkflowStore, WorkflowStore};
use serde_json::json;

#[tokio::test]
async fn workflow_upsert_is_idempotent_on_key() {
    let store = InMemoryWorkflowStore::new();
    let ingest = WorkflowItemIngest {
        idempotency_key: approval_idempotency_key("0xbalance", "0xagent"),
        recipient_address: "0xowner".to_string(),
        item_type: ITEM_TYPE_APPROVAL_REQUEST.to_string(),
        title: "Approve spend".to_string(),
        body: None,
        payload: json!({ "max_amount_mist": 1000 }),
        organization_id: None,
        account_id: None,
        source_service: "oracle".to_string(),
        action_deadline_ms: None,
        conversation_ref: None,
    };

    let first = store.upsert_ingest(&ingest).await.expect("first upsert");
    assert_eq!(first.status, STATUS_OPEN);

    let mut refreshed = ingest.clone();
    refreshed.title = "Approve spend (updated)".to_string();
    let second = store.upsert_ingest(&refreshed).await.expect("second upsert");
    assert_eq!(first.id, second.id);
    assert_eq!(second.title, "Approve spend (updated)");
}

#[tokio::test]
async fn workflow_transition_by_idempotency_only_from_open() {
    let store = InMemoryWorkflowStore::new();
    let key = approval_idempotency_key("0xbalance", "0xagent");
    store
        .upsert_ingest(&WorkflowItemIngest {
            idempotency_key: key.clone(),
            recipient_address: "0xowner".to_string(),
            item_type: ITEM_TYPE_APPROVAL_REQUEST.to_string(),
            title: "Approve spend".to_string(),
            body: None,
            payload: json!({}),
            organization_id: None,
            account_id: None,
            source_service: "oracle".to_string(),
            action_deadline_ms: None,
            conversation_ref: None,
        })
        .await
        .expect("upsert");

    let actioned = store
        .transition_by_idempotency(
            &key,
            STATUS_ACTIONED,
            Some("0xowner"),
            WorkflowTransitionPatch {
                payload_patch: Some(json!({
                    "chain_event": "spend_approved",
                    "approval_nonce": 1,
                    "max_amount_mist": 500,
                })),
                organization_id: None,
            },
        )
        .await
        .expect("transition")
        .expect("row");
    assert_eq!(actioned.status, STATUS_ACTIONED);
    assert_eq!(actioned.payload["approval_nonce"], 1);

    let again = store
        .transition_by_idempotency(&key, STATUS_ACTIONED, Some("0xowner"), WorkflowTransitionPatch::default())
        .await
        .expect("transition again");
    assert!(again.is_none());
}
