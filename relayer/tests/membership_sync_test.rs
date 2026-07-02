//! Integration tests for MembershipSyncService using a mock gRPC server.
//! gRPC stream -> BCS event parsing -> membership store updates

use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;

use myso_rpc::proto::myso::rpc::v2::{
    subscription_service_server::{SubscriptionService, SubscriptionServiceServer},
    Bcs, Checkpoint, Event, ExecutedTransaction, SubscribeCheckpointsRequest,
    SubscribeCheckpointsResponse, TransactionEvents,
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status};

use messaging_relayer::auth::{InMemoryMembershipStore, MembershipStore, MessagingPermission};
use messaging_relayer::config::Config;
use messaging_relayer::services::{MembershipSyncService, MessageGateService};
use messaging_relayer::storage::{InMemoryStorage, NoOpAgentGroupStore};

/// Builds a sync service with in-memory stores and a disabled message gate.
fn new_sync_service(
    config: &Config,
    store: Arc<dyn MembershipStore>,
) -> MembershipSyncService {
    MembershipSyncService::new(
        config,
        store,
        Arc::new(NoOpAgentGroupStore),
        Arc::new(InMemoryStorage::new()),
        MessageGateService::from_config(config),
    )
}

/// BCS layout for MemberAdded / MemberRemoved events
#[derive(serde::Serialize)]
struct MemberEventBcs {
    group_id: [u8; 32],
    member: [u8; 32],
}

/// BCS layout for PermissionsGranted / PermissionsRevoked events
#[derive(serde::Serialize)]
struct PermissionsEventBcs {
    group_id: [u8; 32],
    member: [u8; 32],
    permissions: Vec<TypeNameBcs>,
}

#[derive(serde::Serialize)]
struct TypeNameBcs {
    name: String,
}

// Mock gRPC server

/// A mock implementation of the MySo SubscriptionService gRPC trait.
/// When `subscribe_checkpoints` is called, it streams the pre-configured checkpoints

struct MockSubscriptionService {
    checkpoints: Vec<SubscribeCheckpointsResponse>,
}

impl MockSubscriptionService {
    fn new(checkpoints: Vec<SubscribeCheckpointsResponse>) -> Self {
        Self { checkpoints }
    }
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

/// Starts the mock gRPC server on a random available port and returns its address
async fn start_mock_server(checkpoints: Vec<SubscribeCheckpointsResponse>) -> SocketAddr {
    let service = MockSubscriptionService::new(checkpoints);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    // Spawn the gRPC server in the background
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

// build a Config pointing at the mock server

fn test_config(mock_url: &str, package_id: &str) -> Config {
    let mut config = Config::default();
    config.myso_rpc_url = mock_url.to_string();
    config.groups_package_id = package_id.to_string();
    config
}

// Build mock checkpoint responses and events

/// Constant fake package ID used across all tests
const PACKAGE_ID: &str = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

/// Builds a SubscribeCheckpointsResponse containing one transaction with the given events.
fn make_checkpoint_response(cursor: u64, events: Vec<Event>) -> SubscribeCheckpointsResponse {
    let mut tx_events = TransactionEvents::default();
    tx_events.events = events;

    let mut executed_tx = ExecutedTransaction::default();
    executed_tx.digest = Some(format!("tx_digest_{}", cursor));
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

/// Builds a Bcs message containing the given bytes
fn make_bcs(bytes: Vec<u8>) -> Bcs {
    let mut bcs_msg = Bcs::default();
    bcs_msg.value = Some(bytes.into());
    bcs_msg
}

/// Builds an Event pto with the given type string and BCS-encoded contents
fn make_event(package_id: &str, event_type_suffix: &str, bcs_bytes: Vec<u8>) -> Event {
    let mut event = Event::default();
    event.package_id = Some(package_id.to_string());
    event.module = Some("permissioned_group".to_string());
    event.sender = Some("0xsender".to_string());
    event.event_type = Some(format!(
        "{}::permissioned_group::{}<{}::messaging::Messaging>",
        package_id, event_type_suffix, package_id
    ));
    event.contents = Some(make_bcs(bcs_bytes));
    event
}

/// Builds a MemberAdded event with BCS-encoded contents
fn make_member_added_event(package_id: &str, group_id: &[u8; 32], member: &[u8; 32]) -> Event {
    let bcs_bytes = bcs::to_bytes(&MemberEventBcs {
        group_id: *group_id,
        member: *member,
    })
    .unwrap();
    make_event(package_id, "MemberAdded", bcs_bytes)
}

/// Builds a MemberRemoved event with BCS-encoded contents
fn make_member_removed_event(package_id: &str, group_id: &[u8; 32], member: &[u8; 32]) -> Event {
    let bcs_bytes = bcs::to_bytes(&MemberEventBcs {
        group_id: *group_id,
        member: *member,
    })
    .unwrap();
    make_event(package_id, "MemberRemoved", bcs_bytes)
}

/// Builds a PermissionsGranted event with BCS-encoded contents.
fn make_permissions_granted_event(
    package_id: &str,
    group_id: &[u8; 32],
    member: &[u8; 32],
    permission_names: Vec<String>,
) -> Event {
    let bcs_bytes = bcs::to_bytes(&PermissionsEventBcs {
        group_id: *group_id,
        member: *member,
        permissions: permission_names
            .into_iter()
            .map(|name| TypeNameBcs { name })
            .collect(),
    })
    .unwrap();
    make_event(package_id, "PermissionsGranted", bcs_bytes)
}

/// Builds a PermissionsRevoked event with BCS-encoded contents
fn make_permissions_revoked_event(
    package_id: &str,
    group_id: &[u8; 32],
    member: &[u8; 32],
    permission_names: Vec<String>,
) -> Event {
    let bcs_bytes = bcs::to_bytes(&PermissionsEventBcs {
        group_id: *group_id,
        member: *member,
        permissions: permission_names
            .into_iter()
            .map(|name| TypeNameBcs { name })
            .collect(),
    })
    .unwrap();
    make_event(package_id, "PermissionsRevoked", bcs_bytes)
}

/// Converts a 32-byte array to the hex address format used by the membership store.
fn to_hex_address(bytes: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}

// Tests

#[tokio::test]
async fn test_member_added_event() {
    let group_id = [0x11u8; 32];
    let member = [0x22u8; 32];

    // MemberAdded is followed by PermissionsGranted in the same checkpoint.
    // is_member() only returns true when the member has at least one permission
    let checkpoints = vec![make_checkpoint_response(
        1,
        vec![
            make_member_added_event(PACKAGE_ID, &group_id, &member),
            make_permissions_granted_event(
                PACKAGE_ID,
                &group_id,
                &member,
                vec![format!("{}::messaging::MessagingSender", PACKAGE_ID)],
            ),
        ],
    )];

    // Start the mock gRPC server
    let addr = start_mock_server(checkpoints).await;
    let mock_url = format!("http://{}", addr);

    // Create the membership store we'll verify against
    let store: Arc<dyn MembershipStore> = Arc::new(InMemoryMembershipStore::new());

    // Create the service pointing at our mock server
    let config = test_config(&mock_url, PACKAGE_ID);
    let mut service = new_sync_service(&config, store.clone());

    // Run the subscription, processes mock checkpoints, then stream ends
    let result = service.run_subscription().await;
    assert!(result.is_ok());

    let group_hex = to_hex_address(&group_id);
    let member_hex = to_hex_address(&member);

    // Verify the member was added and has the granted permission
    assert!(store.is_member(&group_hex, &member_hex));
    assert!(store.has_permission(
        &group_hex,
        &member_hex,
        MessagingPermission::MessagingSender
    ));
}

#[tokio::test]
async fn test_member_removed_event() {
    let group_id = [0x11u8; 32];
    let member = [0x22u8; 32];

    // Checkpoint 1: add the member with a permission, Checkpoint 2: remove them
    let checkpoints = vec![
        make_checkpoint_response(
            1,
            vec![
                make_member_added_event(PACKAGE_ID, &group_id, &member),
                make_permissions_granted_event(
                    PACKAGE_ID,
                    &group_id,
                    &member,
                    vec![format!("{}::messaging::MessagingSender", PACKAGE_ID)],
                ),
            ],
        ),
        make_checkpoint_response(
            2,
            vec![make_member_removed_event(PACKAGE_ID, &group_id, &member)],
        ),
    ];

    let addr = start_mock_server(checkpoints).await;
    let mock_url = format!("http://{}", addr);

    let store: Arc<dyn MembershipStore> = Arc::new(InMemoryMembershipStore::new());
    let config = test_config(&mock_url, PACKAGE_ID);
    let mut service = new_sync_service(&config, store.clone());

    let result = service.run_subscription().await;
    assert!(result.is_ok());

    // Member should no longer be in the store
    assert!(!store.is_member(&to_hex_address(&group_id), &to_hex_address(&member)));
}

#[tokio::test]
async fn test_permissions_granted_event() {
    let group_id = [0x11u8; 32];
    let member = [0x22u8; 32];

    // First add the member, then grant permissions (grant requires member to exist)
    let checkpoints = vec![
        make_checkpoint_response(
            1,
            vec![make_member_added_event(PACKAGE_ID, &group_id, &member)],
        ),
        make_checkpoint_response(
            2,
            vec![make_permissions_granted_event(
                PACKAGE_ID,
                &group_id,
                &member,
                vec![
                    format!("{}::messaging::MessagingSender", PACKAGE_ID),
                    format!("{}::messaging::MessagingReader", PACKAGE_ID),
                ],
            )],
        ),
    ];

    let addr = start_mock_server(checkpoints).await;
    let mock_url = format!("http://{}", addr);

    let store: Arc<dyn MembershipStore> = Arc::new(InMemoryMembershipStore::new());
    let config = test_config(&mock_url, PACKAGE_ID);
    let mut service = new_sync_service(&config, store.clone());

    let result = service.run_subscription().await;
    assert!(result.is_ok());

    let group_hex = to_hex_address(&group_id);
    let member_hex = to_hex_address(&member);

    // Verify both permissions were granted
    assert!(store.has_permission(
        &group_hex,
        &member_hex,
        MessagingPermission::MessagingSender
    ));
    assert!(store.has_permission(
        &group_hex,
        &member_hex,
        MessagingPermission::MessagingReader
    ));
    // Permissions that were NOT granted should be absent
    assert!(!store.has_permission(
        &group_hex,
        &member_hex,
        MessagingPermission::MessagingEditor
    ));
    assert!(!store.has_permission(
        &group_hex,
        &member_hex,
        MessagingPermission::MessagingDeleter
    ));
}

#[tokio::test]
async fn test_permissions_revoked_event() {
    let group_id = [0x11u8; 32];
    let member = [0x22u8; 32];

    // Add member then grant two permissions then revoke one
    let checkpoints = vec![
        make_checkpoint_response(
            1,
            vec![make_member_added_event(PACKAGE_ID, &group_id, &member)],
        ),
        make_checkpoint_response(
            2,
            vec![make_permissions_granted_event(
                PACKAGE_ID,
                &group_id,
                &member,
                vec![
                    format!("{}::messaging::MessagingSender", PACKAGE_ID),
                    format!("{}::messaging::MessagingReader", PACKAGE_ID),
                ],
            )],
        ),
        make_checkpoint_response(
            3,
            vec![make_permissions_revoked_event(
                PACKAGE_ID,
                &group_id,
                &member,
                // Revoke only MessagingSender
                vec![format!("{}::messaging::MessagingSender", PACKAGE_ID)],
            )],
        ),
    ];

    let addr = start_mock_server(checkpoints).await;
    let mock_url = format!("http://{}", addr);

    let store: Arc<dyn MembershipStore> = Arc::new(InMemoryMembershipStore::new());
    let config = test_config(&mock_url, PACKAGE_ID);
    let mut service = new_sync_service(&config, store.clone());

    let result = service.run_subscription().await;
    assert!(result.is_ok());

    let group_hex = to_hex_address(&group_id);
    let member_hex = to_hex_address(&member);

    // MessagingSender was revoked
    assert!(!store.has_permission(
        &group_hex,
        &member_hex,
        MessagingPermission::MessagingSender
    ));
    // MessagingReader was not revoked still present
    assert!(store.has_permission(
        &group_hex,
        &member_hex,
        MessagingPermission::MessagingReader
    ));
}

#[tokio::test]
async fn test_multiple_checkpoints_with_multiple_events() {
    let group_id = [0x11u8; 32];
    let member_a = [0x22u8; 32];
    let member_b = [0x33u8; 32];

    // Two members added in separate checkpoints
    let checkpoints = vec![
        make_checkpoint_response(
            1,
            vec![make_member_added_event(PACKAGE_ID, &group_id, &member_a)],
        ),
        make_checkpoint_response(
            2,
            vec![make_member_added_event(PACKAGE_ID, &group_id, &member_b)],
        ),
        // Both get permissions in a single checkpoint (multiple events per checkpoint)
        make_checkpoint_response(
            3,
            vec![
                make_permissions_granted_event(
                    PACKAGE_ID,
                    &group_id,
                    &member_a,
                    vec![format!("{}::messaging::MessagingSender", PACKAGE_ID)],
                ),
                make_permissions_granted_event(
                    PACKAGE_ID,
                    &group_id,
                    &member_b,
                    vec![format!("{}::messaging::MessagingReader", PACKAGE_ID)],
                ),
            ],
        ),
    ];

    let addr = start_mock_server(checkpoints).await;
    let mock_url = format!("http://{}", addr);

    let store: Arc<dyn MembershipStore> = Arc::new(InMemoryMembershipStore::new());
    let config = test_config(&mock_url, PACKAGE_ID);
    let mut service = new_sync_service(&config, store.clone());

    let result = service.run_subscription().await;
    assert!(result.is_ok());

    let group_hex = to_hex_address(&group_id);

    // Both members exist
    assert!(store.is_member(&group_hex, &to_hex_address(&member_a)));
    assert!(store.is_member(&group_hex, &to_hex_address(&member_b)));

    // Each has the correct permission
    assert!(store.has_permission(
        &group_hex,
        &to_hex_address(&member_a),
        MessagingPermission::MessagingSender
    ));
    assert!(store.has_permission(
        &group_hex,
        &to_hex_address(&member_b),
        MessagingPermission::MessagingReader
    ));
}

#[tokio::test]
async fn test_ignores_events_from_other_packages() {
    let group_id = [0x11u8; 32];
    let member = [0x22u8; 32];
    let other_package = "0xaaaaaaaaaaaaa";

    // Event comes from a different package and should be ignored
    let checkpoints = vec![make_checkpoint_response(
        1,
        vec![make_member_added_event(other_package, &group_id, &member)],
    )];

    let addr = start_mock_server(checkpoints).await;
    let mock_url = format!("http://{}", addr);

    let store: Arc<dyn MembershipStore> = Arc::new(InMemoryMembershipStore::new());
    let config = test_config(&mock_url, PACKAGE_ID);
    let mut service = new_sync_service(&config, store.clone());

    let result = service.run_subscription().await;
    assert!(result.is_ok());

    // Member should not have been added since the event was from a different package
    assert!(!store.is_member(&to_hex_address(&group_id), &to_hex_address(&member)));
}

#[tokio::test]
async fn test_duplicate_cursor_is_skipped() {
    let group_id = [0x11u8; 32];
    let member_a = [0x22u8; 32];
    let member_b = [0x33u8; 32];

    // Two checkpoints with the same cursor (sequence number 1).
    // The second one should be skipped by the duplicate cursor check.
    let checkpoints = vec![
        make_checkpoint_response(
            1,
            vec![
                make_member_added_event(PACKAGE_ID, &group_id, &member_a),
                make_permissions_granted_event(
                    PACKAGE_ID,
                    &group_id,
                    &member_a,
                    vec![format!("{}::messaging::MessagingSender", PACKAGE_ID)],
                ),
            ],
        ),
        make_checkpoint_response(
            1, // Same cursor — should be skipped
            vec![
                make_member_added_event(PACKAGE_ID, &group_id, &member_b),
                make_permissions_granted_event(
                    PACKAGE_ID,
                    &group_id,
                    &member_b,
                    vec![format!("{}::messaging::MessagingSender", PACKAGE_ID)],
                ),
            ],
        ),
    ];

    let addr = start_mock_server(checkpoints).await;
    let mock_url = format!("http://{}", addr);

    let store: Arc<dyn MembershipStore> = Arc::new(InMemoryMembershipStore::new());
    let config = test_config(&mock_url, PACKAGE_ID);
    let mut service = new_sync_service(&config, store.clone());

    let result = service.run_subscription().await;
    assert!(result.is_ok());

    // First member was added (cursor 1, first occurrence)
    assert!(store.is_member(&to_hex_address(&group_id), &to_hex_address(&member_a)));
    // Second member was not added (duplicate cursor 1 was skipped)
    assert!(!store.is_member(&to_hex_address(&group_id), &to_hex_address(&member_b)));
}

#[tokio::test]
async fn test_permissions_granted_before_member_added_in_same_checkpoint() {
    let group_id = [0x11u8; 32];
    let member = [0x22u8; 32];

    let checkpoints = vec![make_checkpoint_response(
        1,
        vec![
            make_permissions_granted_event(
                PACKAGE_ID,
                &group_id,
                &member,
                vec![format!("{}::messaging::MessagingSender", PACKAGE_ID)],
            ),
            make_member_added_event(PACKAGE_ID, &group_id, &member),
        ],
    )];

    let addr = start_mock_server(checkpoints).await;
    let mock_url = format!("http://{}", addr);

    let store: Arc<dyn MembershipStore> = Arc::new(InMemoryMembershipStore::new());
    let config = test_config(&mock_url, PACKAGE_ID);
    let mut service = new_sync_service(&config, store.clone());

    let result = service.run_subscription().await;
    assert!(result.is_ok());

    let group_hex = to_hex_address(&group_id);
    let member_hex = to_hex_address(&member);
    assert!(store.has_permission(
        &group_hex,
        &member_hex,
        MessagingPermission::MessagingSender
    ));
}

#[tokio::test]
async fn test_group_create_permission_burst_in_one_checkpoint() {
    let group_id = [0x11u8; 32];
    let member = [0x22u8; 32];

    let checkpoints = vec![make_checkpoint_response(
        1,
        vec![
            make_member_added_event(PACKAGE_ID, &group_id, &member),
            make_permissions_granted_event(
                PACKAGE_ID,
                &group_id,
                &member,
                vec![format!("{}::messaging::MessagingSender", PACKAGE_ID)],
            ),
            make_permissions_granted_event(
                PACKAGE_ID,
                &group_id,
                &member,
                vec![format!("{}::messaging::MessagingReader", PACKAGE_ID)],
            ),
        ],
    )];

    let addr = start_mock_server(checkpoints).await;
    let mock_url = format!("http://{}", addr);

    let store: Arc<dyn MembershipStore> = Arc::new(InMemoryMembershipStore::new());
    let config = test_config(&mock_url, PACKAGE_ID);
    let mut service = new_sync_service(&config, store.clone());

    let result = service.run_subscription().await;
    assert!(result.is_ok());

    let group_hex = to_hex_address(&group_id);
    let member_hex = to_hex_address(&member);
    assert!(store.has_permission(
        &group_hex,
        &member_hex,
        MessagingPermission::MessagingSender
    ));
    assert!(store.has_permission(
        &group_hex,
        &member_hex,
        MessagingPermission::MessagingReader
    ));
}

#[tokio::test]
async fn test_checkpoint_cursor_rewind_clears_cache_and_reprocesses() {
    let group_id = [0x11u8; 32];
    let member_old = [0x22u8; 32];
    let member_new = [0x33u8; 32];

    let checkpoints = vec![
        make_checkpoint_response(
            100,
            vec![
                make_member_added_event(PACKAGE_ID, &group_id, &member_old),
                make_permissions_granted_event(
                    PACKAGE_ID,
                    &group_id,
                    &member_old,
                    vec![format!("{}::messaging::MessagingSender", PACKAGE_ID)],
                ),
            ],
        ),
        make_checkpoint_response(
            5,
            vec![
                make_member_added_event(PACKAGE_ID, &group_id, &member_new),
                make_permissions_granted_event(
                    PACKAGE_ID,
                    &group_id,
                    &member_new,
                    vec![format!("{}::messaging::MessagingSender", PACKAGE_ID)],
                ),
            ],
        ),
    ];

    let addr = start_mock_server(checkpoints).await;
    let mock_url = format!("http://{}", addr);

    let store: Arc<dyn MembershipStore> = Arc::new(InMemoryMembershipStore::new());
    let config = test_config(&mock_url, PACKAGE_ID);
    let mut service = new_sync_service(&config, store.clone());

    let result = service.run_subscription().await;
    assert!(result.is_ok());

    let group_hex = to_hex_address(&group_id);
    assert!(!store.is_member(
        &group_hex,
        &to_hex_address(&member_old)
    ));
    assert!(store.has_permission(
        &group_hex,
        &to_hex_address(&member_new),
        MessagingPermission::MessagingSender
    ));
}
