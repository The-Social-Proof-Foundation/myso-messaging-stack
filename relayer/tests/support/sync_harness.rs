//! Shared harness for MembershipSyncService integration / e2e tests.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;

use messaging_relayer::auth::{InMemoryMembershipStore, MembershipStore};
use messaging_relayer::config::Config;
use messaging_relayer::services::message_gate::MessageGateService;
use messaging_relayer::services::push::PushService;
use messaging_relayer::services::{MembershipSyncService, RealtimeHub};
use messaging_relayer::storage::{
    InMemoryStorage, InMemoryWorkflowStore, NoOpAgentGroupStore, StorageAdapter, WorkflowStore,
};
use myso_rpc::proto::myso::rpc::v2::{
    subscription_service_server::{SubscriptionService, SubscriptionServiceServer},
    Bcs, Checkpoint, Event, ExecutedTransaction, SubscribeCheckpointsRequest,
    SubscribeCheckpointsResponse, TransactionEvents,
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status};

pub const GROUPS_PACKAGE_ID: &str =
    "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
pub const SOCIAL_PACKAGE_ID: &str =
    "0x00000000000000000000000000000000000000000000000000000000000050c1";
pub const MESSAGING_PACKAGE_ID: &str =
    "0x000000000000000000000000000000000000000000000000000000000000e110";

#[derive(serde::Serialize)]
pub struct BcsMoveObjectId {
    pub bytes: [u8; 32],
}

// ==================== Config + harness ====================

pub fn workflow_test_config(mock_url: &str, workflow_enabled: bool) -> Config {
    let mut config = Config::default();
    config.myso_rpc_url = mock_url.to_string();
    config.groups_package_id = GROUPS_PACKAGE_ID.to_string();
    config.social_package_id = SOCIAL_PACKAGE_ID.to_string();
    config.messaging_package_id = MESSAGING_PACKAGE_ID.to_string();
    config.workflow_enabled = workflow_enabled;
    config
}

pub struct SyncTestHarness {
    pub membership_store: Arc<dyn MembershipStore>,
    pub workflow_store: Arc<InMemoryWorkflowStore>,
    pub storage: Arc<InMemoryStorage>,
    pub hub: Arc<RealtimeHub>,
    pub push_service: PushService,
    pub config: Config,
}

impl SyncTestHarness {
    pub fn new(mock_url: &str, workflow_enabled: bool, push_service: PushService) -> Self {
        Self {
            membership_store: Arc::new(InMemoryMembershipStore::new()),
            workflow_store: Arc::new(InMemoryWorkflowStore::new()),
            storage: Arc::new(InMemoryStorage::new()),
            hub: Arc::new(RealtimeHub::new()),
            push_service,
            config: workflow_test_config(mock_url, workflow_enabled),
        }
    }

    pub fn build_sync_service(&self) -> MembershipSyncService {
        MembershipSyncService::new(
            &self.config,
            self.membership_store.clone(),
            Arc::new(NoOpAgentGroupStore),
            self.workflow_store.clone(),
            self.config.workflow_enabled,
            self.storage.clone(),
            MessageGateService::from_config(&self.config),
            self.hub.clone(),
            self.push_service.clone(),
        )
    }

    pub fn workflow_store_trait(&self) -> Arc<dyn WorkflowStore> {
        self.workflow_store.clone()
    }

    pub fn storage_trait(&self) -> Arc<dyn StorageAdapter> {
        self.storage.clone()
    }
}

// ==================== Mock gRPC server ====================

struct MockSubscriptionService {
    checkpoints: Vec<SubscribeCheckpointsResponse>,
}

#[tonic::async_trait]
impl SubscriptionService for MockSubscriptionService {
    type SubscribeCheckpointsStream = Pin<
        Box<dyn tokio_stream::Stream<Item = Result<SubscribeCheckpointsResponse, Status>> + Send>,
    >;

    async fn subscribe_checkpoints(
        &self,
        _request: Request<SubscribeCheckpointsRequest>,
    ) -> Result<Response<Self::SubscribeCheckpointsStream>, Status> {
        let (tx, rx) = mpsc::channel(128);
        let checkpoints = self.checkpoints.clone();
        tokio::spawn(async move {
            for checkpoint in checkpoints {
                if tx.send(Ok(checkpoint)).await.is_err() {
                    break;
                }
            }
        });
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }
}

pub async fn start_mock_server(checkpoints: Vec<SubscribeCheckpointsResponse>) -> SocketAddr {
    let service = MockSubscriptionService { checkpoints };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(SubscriptionServiceServer::new(service))
            .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener))
            .await
            .unwrap();
    });
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    addr
}

// ==================== Checkpoint / event builders ====================

pub fn make_checkpoint_response(cursor: u64, events: Vec<Event>) -> SubscribeCheckpointsResponse {
    let mut tx_events = TransactionEvents::default();
    tx_events.events = events;

    let mut executed_tx = ExecutedTransaction::default();
    executed_tx.digest = Some(format!("tx_digest_{cursor}"));
    executed_tx.events = Some(tx_events);
    executed_tx.checkpoint = Some(cursor);

    let mut checkpoint = Checkpoint::default();
    checkpoint.sequence_number = Some(cursor);
    checkpoint.transactions = vec![executed_tx];

    let mut response = SubscribeCheckpointsResponse::default();
    response.cursor = Some(cursor);
    response.checkpoint = Some(checkpoint);
    response
}

fn make_bcs(bytes: Vec<u8>) -> Bcs {
    let mut bcs_msg = Bcs::default();
    bcs_msg.value = Some(bytes.into());
    bcs_msg
}

pub fn make_package_event(
    package_id: &str,
    module: &str,
    event_suffix: &str,
    bcs_bytes: Vec<u8>,
) -> Event {
    let mut event = Event::default();
    event.package_id = Some(package_id.to_string());
    event.module = Some(module.to_string());
    event.sender = Some("0xsender".to_string());
    event.event_type = Some(format!("{package_id}::{module}::{event_suffix}"));
    event.contents = Some(make_bcs(bcs_bytes));
    event
}

pub fn to_hex_address(bytes: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}

// ==================== Org invitation events ====================

#[derive(serde::Serialize)]
struct BcsOrgInvitationCreated {
    organization_id: BcsMoveObjectId,
    account_id: BcsMoveObjectId,
    invitee: [u8; 32],
    role_name: Option<String>,
    permissions_mask: u64,
    invited_by: [u8; 32],
    expires_at_ms: Option<u64>,
    timestamp_ms: u64,
}

#[derive(serde::Serialize)]
struct BcsOrgInvitationAccepted {
    organization_id: BcsMoveObjectId,
    account_id: BcsMoveObjectId,
    group_id: BcsMoveObjectId,
    invitee: [u8; 32],
    role_name: Option<String>,
    permissions_mask: u64,
    granted_mask: u64,
    accepted_by: [u8; 32],
    timestamp_ms: u64,
}

#[derive(serde::Serialize)]
struct BcsOrgInvitationDeclined {
    organization_id: BcsMoveObjectId,
    account_id: BcsMoveObjectId,
    invitee: [u8; 32],
    declined_by: [u8; 32],
    timestamp_ms: u64,
}

pub fn make_org_invitation_created_event(
    org_id: &[u8; 32],
    account_id: &[u8; 32],
    invitee: &[u8; 32],
    invited_by: &[u8; 32],
) -> Event {
    let bcs_bytes = bcs::to_bytes(&BcsOrgInvitationCreated {
        organization_id: BcsMoveObjectId { bytes: *org_id },
        account_id: BcsMoveObjectId { bytes: *account_id },
        invitee: *invitee,
        role_name: Some("member".to_string()),
        permissions_mask: 3,
        invited_by: *invited_by,
        expires_at_ms: Some(2_000_000_000_000),
        timestamp_ms: 1_700_000_000_000,
    })
    .unwrap();
    make_package_event(
        SOCIAL_PACKAGE_ID,
        "memory",
        "OrgInvitationCreated",
        bcs_bytes,
    )
}

pub fn make_org_invitation_accepted_event(
    org_id: &[u8; 32],
    account_id: &[u8; 32],
    group_id: &[u8; 32],
    invitee: &[u8; 32],
    accepted_by: &[u8; 32],
) -> Event {
    let bcs_bytes = bcs::to_bytes(&BcsOrgInvitationAccepted {
        organization_id: BcsMoveObjectId { bytes: *org_id },
        account_id: BcsMoveObjectId { bytes: *account_id },
        group_id: BcsMoveObjectId { bytes: *group_id },
        invitee: *invitee,
        role_name: Some("member".to_string()),
        permissions_mask: 3,
        granted_mask: 3,
        accepted_by: *accepted_by,
        timestamp_ms: 1_700_000_000_001,
    })
    .unwrap();
    make_package_event(
        SOCIAL_PACKAGE_ID,
        "memory",
        "OrgInvitationAccepted",
        bcs_bytes,
    )
}

pub fn make_org_invitation_declined_event(
    org_id: &[u8; 32],
    account_id: &[u8; 32],
    invitee: &[u8; 32],
    declined_by: &[u8; 32],
) -> Event {
    let bcs_bytes = bcs::to_bytes(&BcsOrgInvitationDeclined {
        organization_id: BcsMoveObjectId { bytes: *org_id },
        account_id: BcsMoveObjectId { bytes: *account_id },
        invitee: *invitee,
        declined_by: *declined_by,
        timestamp_ms: 1_700_000_000_001,
    })
    .unwrap();
    make_package_event(
        SOCIAL_PACKAGE_ID,
        "memory",
        "OrgInvitationDeclined",
        bcs_bytes,
    )
}

// ==================== Org memory permission events ====================

#[derive(serde::Serialize)]
struct BcsOrgMemoryPermissionEvent {
    organization_id: BcsMoveObjectId,
    account_id: BcsMoveObjectId,
    group_id: BcsMoveObjectId,
    member: [u8; 32],
    permissions_mask: u64,
    actor: [u8; 32],
    timestamp_ms: u64,
}

pub fn make_org_memory_permission_granted_event(
    org_id: &[u8; 32],
    account_id: &[u8; 32],
    group_id: &[u8; 32],
    member: &[u8; 32],
    permissions_mask: u64,
    granted_by: &[u8; 32],
) -> Event {
    let bcs_bytes = bcs::to_bytes(&BcsOrgMemoryPermissionEvent {
        organization_id: BcsMoveObjectId { bytes: *org_id },
        account_id: BcsMoveObjectId { bytes: *account_id },
        group_id: BcsMoveObjectId { bytes: *group_id },
        member: *member,
        permissions_mask,
        actor: *granted_by,
        timestamp_ms: 1_700_000_000_002,
    })
    .unwrap();
    make_package_event(
        SOCIAL_PACKAGE_ID,
        "memory",
        "OrgMemoryPermissionGranted",
        bcs_bytes,
    )
}

// ==================== AI credit approval events ====================

#[derive(serde::Serialize)]
struct BcsAiCreditSpendApprovalConsumed {
    balance_id: BcsMoveObjectId,
    agent_object_id: BcsMoveObjectId,
    approval_nonce: u64,
    amount_mist: u64,
    approved_by: [u8; 32],
    timestamp_ms: u64,
}

pub fn make_ai_credit_spend_approval_consumed_event(
    balance_id: &[u8; 32],
    agent_object_id: &[u8; 32],
    approved_by: &[u8; 32],
) -> Event {
    let bcs_bytes = bcs::to_bytes(&BcsAiCreditSpendApprovalConsumed {
        balance_id: BcsMoveObjectId { bytes: *balance_id },
        agent_object_id: BcsMoveObjectId { bytes: *agent_object_id },
        approval_nonce: 1,
        amount_mist: 500,
        approved_by: *approved_by,
        timestamp_ms: 1_700_000_000_003,
    })
    .unwrap();
    make_package_event(
        SOCIAL_PACKAGE_ID,
        "ai_credit",
        "AiCreditSpendApprovalConsumed",
        bcs_bytes,
    )
}

// ==================== Paid message sent ====================

#[derive(serde::Serialize)]
struct BcsPaidMessageSent {
    group_id: BcsMoveObjectId,
    seq: u64,
    payer: [u8; 32],
    recipient: [u8; 32],
    amount: u64,
    created_at_ms: u64,
}

pub fn make_paid_message_sent_event(
    group_id: &[u8; 32],
    seq: u64,
    payer: &[u8; 32],
    recipient: &[u8; 32],
    amount: u64,
) -> Event {
    let bcs_bytes = bcs::to_bytes(&BcsPaidMessageSent {
        group_id: BcsMoveObjectId { bytes: *group_id },
        seq,
        payer: *payer,
        recipient: *recipient,
        amount,
        created_at_ms: 1_700_000_000_004,
    })
    .unwrap();
    make_package_event(
        MESSAGING_PACKAGE_ID,
        "message_log",
        "PaidMessageSent",
        bcs_bytes,
    )
}
