//! E2e tests: mock gRPC checkpoint stream -> MembershipSyncService -> workflow store / escrow / push.

mod support;

use messaging_relayer::models::workflow_item::{
    approval_idempotency_key, memory_access_idempotency_key, org_invitation_idempotency_key,
    WorkflowItemIngest, ITEM_TYPE_APPROVAL_REQUEST, ITEM_TYPE_MEMORY_ACCESS_REQUEST,
    ITEM_TYPE_ORG_INVITATION, STATUS_ACTIONED, STATUS_DISMISSED, STATUS_OPEN,
};
use messaging_relayer::services::push::{ApnsClient, ApnsEnvironment, PushService};
use messaging_relayer::storage::{StorageAdapter, WorkflowStore};
use serde_json::json;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

use support::sync_harness::{
    make_ai_credit_spend_approval_consumed_event, make_checkpoint_response,
    make_org_invitation_accepted_event, make_org_invitation_created_event,
    make_org_invitation_declined_event, make_org_memory_permission_granted_event,
    make_paid_message_sent_event, start_mock_server, to_hex_address, SyncTestHarness,
};

async fn setup_push_service(mock_uri: &str) -> PushService {
    let apns = ApnsClient::from_test_http(
        mock_uri.to_string(),
        "com.example.dripdrop".to_string(),
        ApnsEnvironment::Sandbox,
    );
    PushService::new_for_test(apns, 45)
}

#[tokio::test]
async fn org_invitation_created_ingests_workflow_item() {
    let org_id = [0x01u8; 32];
    let account_id = [0x02u8; 32];
    let invitee = [0x03u8; 32];
    let invited_by = [0x04u8; 32];

    let checkpoints = vec![make_checkpoint_response(
        1,
        vec![make_org_invitation_created_event(
            &org_id,
            &account_id,
            &invitee,
            &invited_by,
        )],
    )];

    let addr = start_mock_server(checkpoints).await;
    let harness = SyncTestHarness::new(
        &format!("http://{addr}"),
        true,
        PushService::from_config(&messaging_relayer::config::Config::default()),
    );
    let mut service = harness.build_sync_service();
    service.run_subscription().await.unwrap();

    let invitee_hex = to_hex_address(&invitee);
    let org_hex = to_hex_address(&org_id);
    let key = org_invitation_idempotency_key(&org_hex, &invitee_hex);
    let items = harness
        .workflow_store
        .list_for_recipient(&invitee_hex, None, None, None, 10)
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].item_type, ITEM_TYPE_ORG_INVITATION);
    assert_eq!(items[0].status, STATUS_OPEN);
    assert_eq!(items[0].idempotency_key, key);
}

#[tokio::test]
async fn org_invitation_created_is_idempotent_on_replay() {
    let org_id = [0x11u8; 32];
    let account_id = [0x12u8; 32];
    let invitee = [0x13u8; 32];
    let invited_by = [0x14u8; 32];
    let event = make_org_invitation_created_event(&org_id, &account_id, &invitee, &invited_by);

    let checkpoints = vec![
        make_checkpoint_response(1, vec![event.clone()]),
        make_checkpoint_response(2, vec![event]),
    ];

    let addr = start_mock_server(checkpoints).await;
    let harness = SyncTestHarness::new(
        &format!("http://{addr}"),
        true,
        PushService::from_config(&messaging_relayer::config::Config::default()),
    );
    let mut service = harness.build_sync_service();
    service.run_subscription().await.unwrap();

    let invitee_hex = to_hex_address(&invitee);
    let items = harness
        .workflow_store
        .list_for_recipient(&invitee_hex, None, None, None, 10)
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].status, STATUS_OPEN);
}

#[tokio::test]
async fn org_invitation_accepted_transitions_to_actioned() {
    let org_id = [0x21u8; 32];
    let account_id = [0x22u8; 32];
    let group_id = [0x23u8; 32];
    let invitee = [0x24u8; 32];
    let invited_by = [0x25u8; 32];
    let accepted_by = invitee;

    let checkpoints = vec![
        make_checkpoint_response(
            1,
            vec![make_org_invitation_created_event(
                &org_id,
                &account_id,
                &invitee,
                &invited_by,
            )],
        ),
        make_checkpoint_response(
            2,
            vec![make_org_invitation_accepted_event(
                &org_id,
                &account_id,
                &group_id,
                &invitee,
                &accepted_by,
            )],
        ),
    ];

    let addr = start_mock_server(checkpoints).await;
    let harness = SyncTestHarness::new(
        &format!("http://{addr}"),
        true,
        PushService::from_config(&messaging_relayer::config::Config::default()),
    );
    let mut service = harness.build_sync_service();
    service.run_subscription().await.unwrap();

    let invitee_hex = to_hex_address(&invitee);
    let items = harness
        .workflow_store
        .list_for_recipient(&invitee_hex, None, None, None, 10)
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].status, STATUS_ACTIONED);
    assert_eq!(
        items[0].actioned_by.as_deref(),
        Some(invitee_hex.as_str())
    );
}

#[tokio::test]
async fn org_invitation_declined_transitions_to_dismissed() {
    let org_id = [0x31u8; 32];
    let account_id = [0x32u8; 32];
    let invitee = [0x33u8; 32];
    let invited_by = [0x34u8; 32];

    let checkpoints = vec![
        make_checkpoint_response(
            1,
            vec![make_org_invitation_created_event(
                &org_id,
                &account_id,
                &invitee,
                &invited_by,
            )],
        ),
        make_checkpoint_response(
            2,
            vec![make_org_invitation_declined_event(
                &org_id,
                &account_id,
                &invitee,
                &invitee,
            )],
        ),
    ];

    let addr = start_mock_server(checkpoints).await;
    let harness = SyncTestHarness::new(
        &format!("http://{addr}"),
        true,
        PushService::from_config(&messaging_relayer::config::Config::default()),
    );
    let mut service = harness.build_sync_service();
    service.run_subscription().await.unwrap();

    let invitee_hex = to_hex_address(&invitee);
    let items = harness
        .workflow_store
        .list_for_recipient(&invitee_hex, None, None, None, 10)
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].status, STATUS_DISMISSED);
}

#[tokio::test]
async fn memory_access_grant_closes_matching_request() {
    let org_id = [0x41u8; 32];
    let account_id = [0x42u8; 32];
    let group_id = [0x43u8; 32];
    let member = [0x44u8; 32];
    let admin = [0x45u8; 32];
    let mask = 1u64;

    let org_hex = to_hex_address(&org_id);
    let member_hex = to_hex_address(&member);
    let key = memory_access_idempotency_key(&org_hex, &member_hex, mask as i64);

    let addr = start_mock_server(vec![make_checkpoint_response(
        1,
        vec![make_org_memory_permission_granted_event(
            &org_id,
            &account_id,
            &group_id,
            &member,
            mask,
            &admin,
        )],
    )])
    .await;

    let harness = SyncTestHarness::new(
        &format!("http://{addr}"),
        true,
        PushService::from_config(&messaging_relayer::config::Config::default()),
    );

    harness
        .workflow_store
        .upsert_ingest(&WorkflowItemIngest {
            idempotency_key: key.clone(),
            recipient_address: to_hex_address(&admin),
            item_type: ITEM_TYPE_MEMORY_ACCESS_REQUEST.to_string(),
            title: "Memory access requested".to_string(),
            body: None,
            payload: json!({ "member_address": member_hex, "permissions_mask": mask }),
            organization_id: Some(org_hex.clone()),
            account_id: Some(to_hex_address(&account_id)),
            source_service: "memory_relayer".to_string(),
            action_deadline_ms: None,
            conversation_ref: None,
        })
        .await
        .unwrap();

    let mut service = harness.build_sync_service();
    service.run_subscription().await.unwrap();

    let items = harness
        .workflow_store
        .list_for_recipient(&to_hex_address(&admin), None, None, None, 10)
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].status, STATUS_ACTIONED);
    assert_eq!(items[0].actioned_by.as_deref(), Some(to_hex_address(&admin).as_str()));
}

#[tokio::test]
async fn ai_credit_approval_consumed_transitions_item() {
    let balance_id = [0x51u8; 32];
    let agent_object_id = [0x52u8; 32];
    let approver = [0x53u8; 32];
    let owner = [0x54u8; 32];

    let balance_hex = to_hex_address(&balance_id);
    let agent_hex = to_hex_address(&agent_object_id);
    let key = approval_idempotency_key(&balance_hex, &agent_hex);

    let addr = start_mock_server(vec![make_checkpoint_response(
        1,
        vec![make_ai_credit_spend_approval_consumed_event(
            &balance_id,
            &agent_object_id,
            &approver,
        )],
    )])
    .await;

    let harness = SyncTestHarness::new(
        &format!("http://{addr}"),
        true,
        PushService::from_config(&messaging_relayer::config::Config::default()),
    );

    harness
        .workflow_store
        .upsert_ingest(&WorkflowItemIngest {
            idempotency_key: key.clone(),
            recipient_address: to_hex_address(&owner),
            item_type: ITEM_TYPE_APPROVAL_REQUEST.to_string(),
            title: "Approval requested".to_string(),
            body: None,
            payload: json!({ "balance_id": balance_hex, "agent_object_id": agent_hex }),
            organization_id: None,
            account_id: None,
            source_service: "oracle".to_string(),
            action_deadline_ms: None,
            conversation_ref: None,
        })
        .await
        .unwrap();

    let mut service = harness.build_sync_service();
    service.run_subscription().await.unwrap();

    let items = harness
        .workflow_store
        .list_for_recipient(&to_hex_address(&owner), None, None, None, 10)
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].status, STATUS_ACTIONED);
}

#[tokio::test]
async fn workflow_events_ignored_when_workflow_disabled() {
    let org_id = [0x61u8; 32];
    let account_id = [0x62u8; 32];
    let invitee = [0x63u8; 32];
    let invited_by = [0x64u8; 32];

    let checkpoints = vec![make_checkpoint_response(
        1,
        vec![make_org_invitation_created_event(
            &org_id,
            &account_id,
            &invitee,
            &invited_by,
        )],
    )];

    let addr = start_mock_server(checkpoints).await;
    let harness = SyncTestHarness::new(
        &format!("http://{addr}"),
        false,
        PushService::from_config(&messaging_relayer::config::Config::default()),
    );
    let mut service = harness.build_sync_service();
    service.run_subscription().await.unwrap();

    let items = harness
        .workflow_store
        .list_for_recipient(&to_hex_address(&invitee), None, None, None, 10)
        .await
        .unwrap();
    assert!(items.is_empty());
}

#[tokio::test]
async fn paid_message_sent_indexes_escrow() {
    let group_id = [0x71u8; 32];
    let payer = [0x72u8; 32];
    let recipient = [0x73u8; 32];

    let checkpoints = vec![make_checkpoint_response(
        1,
        vec![make_paid_message_sent_event(&group_id, 0, &payer, &recipient, 1_000_000_000)],
    )];

    let addr = start_mock_server(checkpoints).await;
    let harness = SyncTestHarness::new(
        &format!("http://{addr}"),
        false,
        PushService::from_config(&messaging_relayer::config::Config::default()),
    );
    let mut service = harness.build_sync_service();
    service.run_subscription().await.unwrap();

    let group_hex = to_hex_address(&group_id);
    let payer_hex = to_hex_address(&payer);
    let recipient_hex = to_hex_address(&recipient);
    assert!(
        harness
            .storage
            .has_paid_escrow(&group_hex, &payer_hex, &recipient_hex, 0)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn paid_message_sent_replay_is_safe() {
    let group_id = [0x81u8; 32];
    let payer = [0x82u8; 32];
    let recipient = [0x83u8; 32];
    let event = make_paid_message_sent_event(&group_id, 0, &payer, &recipient, 500);

    let checkpoints = vec![
        make_checkpoint_response(1, vec![event.clone()]),
        make_checkpoint_response(2, vec![event]),
    ];

    let addr = start_mock_server(checkpoints).await;
    let harness = SyncTestHarness::new(
        &format!("http://{addr}"),
        false,
        PushService::from_config(&messaging_relayer::config::Config::default()),
    );
    let mut service = harness.build_sync_service();
    assert!(service.run_subscription().await.is_ok());

    let group_hex = to_hex_address(&group_id);
    let payer_hex = to_hex_address(&payer);
    let recipient_hex = to_hex_address(&recipient);
    assert!(
        harness
            .storage
            .has_paid_escrow(&group_hex, &payer_hex, &recipient_hex, 0)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn org_invitation_created_sends_workflow_push() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path_regex(r"/3/device/.*"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&mock)
        .await;

    let org_id = [0x91u8; 32];
    let account_id = [0x92u8; 32];
    let invitee = [0x93u8; 32];
    let invited_by = [0x94u8; 32];

    let checkpoints = vec![make_checkpoint_response(
        1,
        vec![make_org_invitation_created_event(
            &org_id,
            &account_id,
            &invitee,
            &invited_by,
        )],
    )];

    let addr = start_mock_server(checkpoints).await;
    let push = setup_push_service(&mock.uri()).await;
    let harness = SyncTestHarness::new(&format!("http://{addr}"), true, push);

    let invitee_hex = to_hex_address(&invitee);
    harness
        .storage
        .upsert_push_token(messaging_relayer::models::PushTokenRecord {
            wallet: invitee_hex.clone(),
            platform: "ios".to_string(),
            token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            environment: "sandbox".to_string(),
            updated_at: chrono::Utc::now(),
        })
        .await
        .unwrap();

    let mut service = harness.build_sync_service();
    service.run_subscription().await.unwrap();

    mock.verify().await;
}

#[tokio::test]
async fn workflow_push_skipped_when_recipient_active() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path_regex(r"/3/device/.*"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&mock)
        .await;

    let org_id = [0xa1u8; 32];
    let account_id = [0xa2u8; 32];
    let invitee = [0xa3u8; 32];
    let invited_by = [0xa4u8; 32];

    let checkpoints = vec![make_checkpoint_response(
        1,
        vec![make_org_invitation_created_event(
            &org_id,
            &account_id,
            &invitee,
            &invited_by,
        )],
    )];

    let addr = start_mock_server(checkpoints).await;
    let push = setup_push_service(&mock.uri()).await;
    let harness = SyncTestHarness::new(&format!("http://{addr}"), true, push);

    let invitee_hex = to_hex_address(&invitee);
    harness
        .storage
        .upsert_push_token(messaging_relayer::models::PushTokenRecord {
            wallet: invitee_hex.clone(),
            platform: "ios".to_string(),
            token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            environment: "sandbox".to_string(),
            updated_at: chrono::Utc::now(),
        })
        .await
        .unwrap();
    harness.storage.update_presence(&invitee_hex).await.unwrap();

    let mut service = harness.build_sync_service();
    service.run_subscription().await.unwrap();

    mock.verify().await;
}
