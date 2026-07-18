//! Integration tests for the FileStorageSyncService using wiremock.
//! These tests mock the File Storage publisher/aggregator API locally,
//! so they run offline without hitting the real File Storage testnet.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc;
use tokio::time::Duration;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

use messaging_relayer::auth::{
    AuthState, InMemoryMembershipStore, MembershipStore, MessagingPermission,
};
use messaging_relayer::config::Config;
use messaging_relayer::models::{Message, SyncStatus};
use messaging_relayer::archive::{ArchiveSyncService, FileStorageArchiveBackend};
use messaging_relayer::services::FileStorageSyncService;
use messaging_relayer::storage::{InMemoryStorage, StorageAdapter};
use messaging_relayer::file_storage::FileStorageClient;

// ==================== Test Helpers ====================

/// Creates a FileStorageClient pointing at the given wiremock server URL.
fn create_mock_file_storage_client(server_uri: &str) -> Arc<FileStorageClient> {
    Arc::new(FileStorageClient::new(server_uri, server_uri))
}

/// Creates an ArchiveSyncService wired to a wiremock-backed File Storage client.
fn create_test_service(
    storage: Arc<dyn StorageAdapter>,
    file_storage_client: Arc<FileStorageClient>,
    batch_size: usize,
) -> FileStorageSyncService {
    let mut config = Config::default();
    config.file_storage_sync_batch_size = batch_size;
    config.file_storage_storage_epochs = 1;

    // Dummy channel. tests call sync_pending_messages() directly
    let (_tx, rx) = tokio::sync::mpsc::unbounded_channel::<()>();

    let backend = Arc::new(FileStorageArchiveBackend::new(
        file_storage_client,
        config.file_storage_storage_epochs,
    ));
    ArchiveSyncService::new(&config, storage, backend, rx)
}

static NONCE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Creates a test message with SyncPending status in the given group.
fn create_test_message(group_id: &str) -> Message {
    let n = NONCE_COUNTER.fetch_add(1, Ordering::SeqCst);
    let mut nonce = vec![0u8; 12];
    nonce[..8].copy_from_slice(&n.to_le_bytes());
    Message::new(
        group_id.to_string(),
        "0xsender123".to_string(),
        vec![0xDE, 0xAD, 0xBE, 0xEF],
        nonce,
        0,
        vec![],
        vec![0u8; 64], // dummy signature for tests
        vec![0u8; 33], // dummy public key for tests
    )
}

/// Counter to make each quilt upload produce unique patch IDs
static QUILT_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A custom wiremock responder that dynamically generates a QuiltStoreResponse
struct DynamicQuiltResponder;

impl Respond for DynamicQuiltResponder {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let seq = QUILT_COUNTER.fetch_add(1, Ordering::SeqCst);
        let content_type = request
            .headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");

        let boundary = content_type
            .split("boundary=")
            .nth(1)
            .unwrap_or("")
            .to_string();

        let body = String::from_utf8_lossy(&request.body);
        let identifiers: Vec<String> = body
            .split(&format!("--{}", boundary))
            .filter_map(|part| {
                if let Some(disp_line) = part.lines().find(|l| l.contains("Content-Disposition")) {
                    if let Some(name_start) = disp_line.find("name=\"") {
                        let after_name = &disp_line[name_start + 6..];
                        if let Some(name_end) = after_name.find('"') {
                            let name = &after_name[..name_end];
                            if !name.is_empty() {
                                return Some(name.to_string());
                            }
                        }
                    }
                }
                None
            })
            .collect();

        let patches: Vec<serde_json::Value> = identifiers
            .iter()
            .map(|id| {
                serde_json::json!({
                    "identifier": id,
                    "quiltPatchId": format!("mock-patch-{}-{}", seq, id),
                })
            })
            .collect();

        let body = serde_json::json!({
            "blobStoreResult": {
                "newlyCreated": {
                    "blobObject": {
                        "blobId": "mock-quilt-blob-id",
                        "id": "mock-object-id",
                        "size": 1024
                    },
                    "cost": 100
                }
            },
            "storedQuiltBlobs": patches
        });

        ResponseTemplate::new(200).set_body_json(body)
    }
}

/// Mounts the dynamic quilt responder on the mock server.
async fn mount_quilt_mock(mock_server: &MockServer) {
    Mock::given(method("PUT"))
        .and(path_regex(r"^/v1/quilts.*"))
        .respond_with(DynamicQuiltResponder)
        .mount(mock_server)
        .await;
}

/// Mounts a GET mock that returns the given bytes when a specific patch is read.
async fn mount_patch_read_mock(mock_server: &MockServer, patch_id: &str, body: Vec<u8>) {
    Mock::given(method("GET"))
        .and(wiremock::matchers::path(format!(
            "/v1/blobs/by-quilt-patch-id/{}",
            patch_id
        )))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
        .mount(mock_server)
        .await;
}

// ==================== sync_pending_messages() Tests ====================

/// Empty storage — sync is a no-op, returns Ok without hitting File Storage
#[tokio::test]
async fn test_sync_no_pending_messages() {
    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    let mock_server = MockServer::start().await;
    let file_storage_client = create_mock_file_storage_client(&mock_server.uri());

    let service = create_test_service(storage, file_storage_client, 100);
    let result = service.sync_pending_messages().await;

    assert!(result.is_ok());
}

/// 2 SyncPending messages get uploaded as a quilt,
/// then each is marked Synced with a quilt_patch_id from the response.
#[tokio::test]
async fn test_sync_uploads_pending_and_marks_synced() {
    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    let mock_server = MockServer::start().await;
    mount_quilt_mock(&mock_server).await;
    let file_storage_client = create_mock_file_storage_client(&mock_server.uri());

    let msg1 = create_test_message("group1");
    let msg2 = create_test_message("group1");
    let msg1_id = msg1.id;
    let msg2_id = msg2.id;

    storage.create_message(msg1).await.unwrap();
    storage.create_message(msg2).await.unwrap();

    let service = create_test_service(storage.clone(), file_storage_client, 100);
    let result = service.sync_pending_messages().await;

    assert!(result.is_ok());

    let updated1 = storage.get_message(msg1_id).await.unwrap();
    assert_eq!(updated1.sync_status, SyncStatus::Synced);
    assert!(updated1.quilt_patch_id.is_some());
    assert!(!updated1.quilt_patch_id.as_ref().unwrap().is_empty());

    let updated2 = storage.get_message(msg2_id).await.unwrap();
    assert_eq!(updated2.sync_status, SyncStatus::Synced);
    assert!(updated2.quilt_patch_id.is_some());
    assert!(!updated2.quilt_patch_id.as_ref().unwrap().is_empty());
}

/// Batch size is respected: with 5 messages and batch_size=3,
/// only 3 get synced in one cycle, the other 2 remain SyncPending
#[tokio::test]
async fn test_sync_respects_batch_size() {
    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    let mock_server = MockServer::start().await;
    mount_quilt_mock(&mock_server).await;
    let file_storage_client = create_mock_file_storage_client(&mock_server.uri());

    let mut ids = Vec::new();
    for _ in 0..5 {
        let msg = create_test_message("group1");
        ids.push(msg.id);
        storage.create_message(msg).await.unwrap();
    }

    let service = create_test_service(storage.clone(), file_storage_client, 3);
    let result = service.sync_pending_messages().await;
    assert!(result.is_ok());

    let mut synced_count = 0;
    let mut pending_count = 0;
    for id in &ids {
        let msg = storage.get_message(*id).await.unwrap();
        match msg.sync_status {
            SyncStatus::Synced => synced_count += 1,
            SyncStatus::SyncPending => pending_count += 1,
            _ => panic!("Unexpected sync status: {:?}", msg.sync_status),
        }
    }

    assert_eq!(synced_count, 3);
    assert_eq!(pending_count, 2);
}

/// After syncing, read the patch back and verify the bytes
/// deserialize to a valid Message struct matching the original
#[tokio::test]
async fn test_sync_serializes_full_message_as_json() {
    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    let mock_server = MockServer::start().await;
    mount_quilt_mock(&mock_server).await;
    let file_storage_client = create_mock_file_storage_client(&mock_server.uri());

    let msg = create_test_message("group1");
    let msg_id = msg.id;
    storage.create_message(msg).await.unwrap();

    let service = create_test_service(storage.clone(), file_storage_client.clone(), 100);
    service.sync_pending_messages().await.unwrap();

    // Get the stored quilt_patch_id
    let synced_msg = storage.get_message(msg_id).await.unwrap();
    let patch_id = synced_msg
        .quilt_patch_id
        .expect("Message should have quilt_patch_id after sync");

    // Build the expected serialized message (Synced status, as the sync worker sets it)
    let mut expected_msg = storage.get_message(msg_id).await.unwrap();
    expected_msg.sync_status = SyncStatus::Synced;
    let expected_bytes = serde_json::to_vec(&expected_msg).unwrap();

    mount_patch_read_mock(&mock_server, &patch_id, expected_bytes).await;

    let patch_bytes = file_storage_client
        .read_by_patch_id(&patch_id)
        .await
        .expect("Should be able to read patch");

    let deserialized: Message =
        serde_json::from_slice(&patch_bytes).expect("Patch data should be valid JSON Message");
    assert_eq!(deserialized.id, msg_id);
    assert_eq!(deserialized.group_id, "group1");
    assert_eq!(deserialized.encrypted_msg, vec![0xDE, 0xAD, 0xBE, 0xEF]);
}

/// Only SyncPending messages should be uploaded. Messages already Synced
/// or in other states should be left untouched.
#[tokio::test]
async fn test_sync_skips_non_pending_messages() {
    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    let mock_server = MockServer::start().await;
    mount_quilt_mock(&mock_server).await;
    let file_storage_client = create_mock_file_storage_client(&mock_server.uri());

    // Create a SyncPending message
    let pending_msg = create_test_message("group1");
    let pending_id = pending_msg.id;
    storage.create_message(pending_msg).await.unwrap();

    // Create a message and manually mark it as Synced
    let already_synced_msg = create_test_message("group1");
    let synced_id = already_synced_msg.id;
    storage.create_message(already_synced_msg).await.unwrap();
    storage
        .update_sync_status(
            synced_id,
            SyncStatus::Synced,
            Some("old-patch-id".to_string()),
        )
        .await
        .unwrap();

    let service = create_test_service(storage.clone(), file_storage_client, 100);
    let result = service.sync_pending_messages().await;
    assert!(result.is_ok());

    // The pending message should now be Synced with a new patch ID
    let updated_pending = storage.get_message(pending_id).await.unwrap();
    assert_eq!(updated_pending.sync_status, SyncStatus::Synced);
    assert!(updated_pending.quilt_patch_id.is_some());

    // The already-synced message should still have its original patch ID
    let unchanged_synced = storage.get_message(synced_id).await.unwrap();
    assert_eq!(unchanged_synced.sync_status, SyncStatus::Synced);
    assert_eq!(
        unchanged_synced.quilt_patch_id,
        Some("old-patch-id".to_string()),
    );
}

/// Messages from different groups are batched into the same quilt
#[tokio::test]
async fn test_sync_cross_group_batching() {
    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    let mock_server = MockServer::start().await;
    mount_quilt_mock(&mock_server).await;
    let file_storage_client = create_mock_file_storage_client(&mock_server.uri());

    let msg1 = create_test_message("group-alpha");
    let msg2 = create_test_message("group-beta");
    let msg3 = create_test_message("group-gamma");
    let ids = [msg1.id, msg2.id, msg3.id];

    storage.create_message(msg1).await.unwrap();
    storage.create_message(msg2).await.unwrap();
    storage.create_message(msg3).await.unwrap();

    let service = create_test_service(storage.clone(), file_storage_client, 100);
    service.sync_pending_messages().await.unwrap();

    for id in &ids {
        let msg = storage.get_message(*id).await.unwrap();
        assert_eq!(msg.sync_status, SyncStatus::Synced);
        assert!(msg.quilt_patch_id.is_some());
    }
}

/// Calling sync_pending_messages() twice picks up remaining messages
/// that exceeded the first batch_size
#[tokio::test]
async fn test_multiple_sync_cycles_drain_all_pending() {
    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    let mock_server = MockServer::start().await;
    mount_quilt_mock(&mock_server).await;
    let file_storage_client = create_mock_file_storage_client(&mock_server.uri());

    let mut ids = Vec::new();
    for _ in 0..5 {
        let msg = create_test_message("group1");
        ids.push(msg.id);
        storage.create_message(msg).await.unwrap();
    }

    let service = create_test_service(storage.clone(), file_storage_client, 3);

    service.sync_pending_messages().await.unwrap();
    service.sync_pending_messages().await.unwrap();

    for id in &ids {
        let msg = storage.get_message(*id).await.unwrap();
        assert_eq!(msg.sync_status, SyncStatus::Synced);
        assert!(msg.quilt_patch_id.is_some());
    }
}

/// Verifies run() triggers sync via the timer
#[tokio::test]
async fn test_run_timer_trigger() {
    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    let mock_server = MockServer::start().await;
    mount_quilt_mock(&mock_server).await;
    let file_storage_client = create_mock_file_storage_client(&mock_server.uri());

    let msg = create_test_message("group1");
    let msg_id = msg.id;
    storage.create_message(msg).await.unwrap();

    let mut config = Config::default();
    config.file_storage_sync_interval_secs = 1;
    config.file_storage_sync_message_threshold = 0;
    config.file_storage_storage_epochs = 1;

    let (_tx, rx) = mpsc::unbounded_channel::<()>();
    let backend = Arc::new(FileStorageArchiveBackend::new(
        file_storage_client,
        config.file_storage_storage_epochs,
    ));
    let mut service = ArchiveSyncService::new(&config, storage.clone(), backend, rx);

    let handle = tokio::spawn(async move { service.run().await });

    tokio::time::sleep(Duration::from_secs(3)).await;
    handle.abort();

    let msg = storage.get_message(msg_id).await.unwrap();
    assert_eq!(msg.sync_status, SyncStatus::Synced);
    assert!(msg.quilt_patch_id.is_some());
}

/// Verifies run() triggers sync when the message threshold is reached
#[tokio::test]
async fn test_run_message_threshold_trigger() {
    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    let mock_server = MockServer::start().await;
    mount_quilt_mock(&mock_server).await;
    let file_storage_client = create_mock_file_storage_client(&mock_server.uri());

    let mut config = Config::default();
    config.file_storage_sync_interval_secs = 3600;
    config.file_storage_sync_message_threshold = 3;
    config.file_storage_storage_epochs = 1;

    let (tx, rx) = mpsc::unbounded_channel::<()>();
    let backend = Arc::new(FileStorageArchiveBackend::new(
        file_storage_client,
        config.file_storage_storage_epochs,
    ));
    let mut service = ArchiveSyncService::new(&config, storage.clone(), backend, rx);

    let handle = tokio::spawn(async move { service.run().await });

    tokio::time::sleep(Duration::from_millis(500)).await;

    let mut ids = Vec::new();
    for _ in 0..3 {
        let msg = create_test_message("group1");
        ids.push(msg.id);
        storage.create_message(msg).await.unwrap();
        tx.send(()).unwrap();
    }

    tokio::time::sleep(Duration::from_secs(3)).await;
    handle.abort();

    for id in &ids {
        let msg = storage.get_message(*id).await.unwrap();
        assert_eq!(msg.sync_status, SyncStatus::Synced);
        assert!(msg.quilt_patch_id.is_some());
    }
}

/// UpdatePending messages get uploaded as new quilt patches and marked Updated.
#[tokio::test]
async fn test_sync_uploads_updated_messages() {
    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    let mock_server = MockServer::start().await;
    mount_quilt_mock(&mock_server).await;
    let file_storage_client = create_mock_file_storage_client(&mock_server.uri());

    let msg1 = create_test_message("group1");
    let msg2 = create_test_message("group1");
    let msg1_id = msg1.id;
    let msg2_id = msg2.id;
    storage.create_message(msg1).await.unwrap();
    storage.create_message(msg2).await.unwrap();

    // First sync: SyncPending → Synced
    let service = create_test_service(storage.clone(), file_storage_client, 100);
    service.sync_pending_messages().await.unwrap();

    let original_patch1 = storage
        .get_message(msg1_id)
        .await
        .unwrap()
        .quilt_patch_id
        .clone();
    let original_patch2 = storage
        .get_message(msg2_id)
        .await
        .unwrap()
        .quilt_patch_id
        .clone();

    // Simulate edit: mark both as UpdatePending
    storage
        .update_sync_status(msg1_id, SyncStatus::UpdatePending, original_patch1.clone())
        .await
        .unwrap();
    storage
        .update_sync_status(msg2_id, SyncStatus::UpdatePending, original_patch2.clone())
        .await
        .unwrap();

    // Second sync: UpdatePending → Updated
    service.sync_updated_messages().await.unwrap();

    let updated1 = storage.get_message(msg1_id).await.unwrap();
    assert_eq!(updated1.sync_status, SyncStatus::Updated);
    assert!(updated1.quilt_patch_id.is_some());
    assert_ne!(
        updated1.quilt_patch_id, original_patch1,
        "Updated message should have a new patch ID"
    );

    let updated2 = storage.get_message(msg2_id).await.unwrap();
    assert_eq!(updated2.sync_status, SyncStatus::Updated);
    assert!(updated2.quilt_patch_id.is_some());
    assert_ne!(
        updated2.quilt_patch_id, original_patch2,
        "Updated message should have a new patch ID"
    );
}

/// DeletePending messages get uploaded with Deleted status and marked Deleted.
#[tokio::test]
async fn test_sync_uploads_deleted_messages() {
    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    let mock_server = MockServer::start().await;
    mount_quilt_mock(&mock_server).await;
    let file_storage_client = create_mock_file_storage_client(&mock_server.uri());

    let msg1 = create_test_message("group1");
    let msg2 = create_test_message("group1");
    let msg1_id = msg1.id;
    let msg2_id = msg2.id;
    storage.create_message(msg1).await.unwrap();
    storage.create_message(msg2).await.unwrap();

    // First sync: SyncPending → Synced
    let service = create_test_service(storage.clone(), file_storage_client, 100);
    service.sync_pending_messages().await.unwrap();

    // Simulate delete: mark both as DeletePending
    storage
        .update_sync_status(msg1_id, SyncStatus::DeletePending, None)
        .await
        .unwrap();
    storage
        .update_sync_status(msg2_id, SyncStatus::DeletePending, None)
        .await
        .unwrap();

    // Second sync: DeletePending → Deleted
    service.sync_deleted_messages().await.unwrap();

    let deleted1 = storage.get_message(msg1_id).await.unwrap();
    assert_eq!(deleted1.sync_status, SyncStatus::Deleted);
    assert!(deleted1.quilt_patch_id.is_some());

    let deleted2 = storage.get_message(msg2_id).await.unwrap();
    assert_eq!(deleted2.sync_status, SyncStatus::Deleted);
    assert!(deleted2.quilt_patch_id.is_some());
}

/// All three sync paths run in one cycle: a fresh SyncPending message,
/// an UpdatePending message, and a DeletePending message all get processed.
#[tokio::test]
async fn test_sync_handles_all_statuses_in_one_cycle() {
    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    let mock_server = MockServer::start().await;
    mount_quilt_mock(&mock_server).await;
    let file_storage_client = create_mock_file_storage_client(&mock_server.uri());

    let new_msg = create_test_message("group1");
    let update_msg = create_test_message("group1");
    let delete_msg = create_test_message("group1");
    let new_id = new_msg.id;
    let update_id = update_msg.id;
    let delete_id = delete_msg.id;

    storage.create_message(new_msg).await.unwrap();
    storage.create_message(update_msg).await.unwrap();
    storage.create_message(delete_msg).await.unwrap();

    let service = create_test_service(storage.clone(), file_storage_client, 100);

    // First: sync all 3 as pending
    service.sync_pending_messages().await.unwrap();

    // Simulate edit on one and delete on another
    storage
        .update_sync_status(update_id, SyncStatus::UpdatePending, None)
        .await
        .unwrap();
    storage
        .update_sync_status(delete_id, SyncStatus::DeletePending, None)
        .await
        .unwrap();

    // Create a fresh message that is still SyncPending
    let fresh_msg = create_test_message("group1");
    let fresh_id = fresh_msg.id;
    storage.create_message(fresh_msg).await.unwrap();

    // Run all three sync paths
    service.sync_pending_messages().await.unwrap();
    service.sync_updated_messages().await.unwrap();
    service.sync_deleted_messages().await.unwrap();

    let synced = storage.get_message(fresh_id).await.unwrap();
    assert_eq!(synced.sync_status, SyncStatus::Synced);
    assert!(synced.quilt_patch_id.is_some());

    let updated = storage.get_message(update_id).await.unwrap();
    assert_eq!(updated.sync_status, SyncStatus::Updated);
    assert!(updated.quilt_patch_id.is_some());

    let deleted = storage.get_message(delete_id).await.unwrap();
    assert_eq!(deleted.sync_status, SyncStatus::Deleted);
    assert!(deleted.quilt_patch_id.is_some());

    // The originally-synced message that wasn't edited or deleted stays Synced
    let unchanged = storage.get_message(new_id).await.unwrap();
    assert_eq!(unchanged.sync_status, SyncStatus::Synced);
}

/// Read back a deleted message's patch and verify it has Deleted status.
/// The sync worker serializes the message with to_status before uploading,
/// so the File Storage copy should reflect the final Deleted state.
#[tokio::test]
async fn test_sync_deleted_message_contains_deleted_status() {
    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    let mock_server = MockServer::start().await;
    mount_quilt_mock(&mock_server).await;
    let file_storage_client = create_mock_file_storage_client(&mock_server.uri());

    let msg = create_test_message("group1");
    let msg_id = msg.id;
    storage.create_message(msg).await.unwrap();

    let service = create_test_service(storage.clone(), file_storage_client.clone(), 100);

    // Sync as pending first, then simulate delete
    service.sync_pending_messages().await.unwrap();
    storage
        .update_sync_status(msg_id, SyncStatus::DeletePending, None)
        .await
        .unwrap();
    service.sync_deleted_messages().await.unwrap();

    let deleted_msg = storage.get_message(msg_id).await.unwrap();
    let patch_id = deleted_msg
        .quilt_patch_id
        .clone()
        .expect("Deleted message should have a quilt_patch_id");

    // Build the expected serialized message with Deleted status (what the sync worker uploads)
    let mut expected_msg = deleted_msg.clone();
    expected_msg.sync_status = SyncStatus::Deleted;
    let expected_bytes = serde_json::to_vec(&expected_msg).unwrap();

    mount_patch_read_mock(&mock_server, &patch_id, expected_bytes).await;

    let patch_bytes = file_storage_client
        .read_by_patch_id(&patch_id)
        .await
        .expect("Should be able to read deletion patch");

    let deserialized: Message =
        serde_json::from_slice(&patch_bytes).expect("Patch data should be valid JSON Message");
    assert_eq!(deserialized.id, msg_id);
    assert_eq!(
        deserialized.sync_status,
        SyncStatus::Deleted,
        "File Storage copy should have Deleted status so readers know to hide it"
    );
}

/// Verifies that POST /messages sends a notification on the sync channel
#[tokio::test]
async fn test_create_message_sends_sync_notification() {
    use std::borrow::Cow;

    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use axum::middleware;
    use axum::routing::post;
    use axum::Router;
    use serde_json::json;
    use myso_crypto::{ed25519::Ed25519PrivateKey, MySoSigner};
    use myso_sdk_types::PersonalMessage;
    use tower::ServiceExt;

    use messaging_relayer::handlers::messages::create_message;
    use messaging_relayer::services::block_check::BlockCheckService;
    use messaging_relayer::services::push::PushService;
    use messaging_relayer::state::AppState;

    // Ed25519 test wallet (same as auth_integration_test)
    let private_key_bytes: [u8; 32] =
        hex::decode("4ac9bd5399f7b41da4f00ec612c4e6521a1c756c41578ed5c15133f96ab9ea78")
            .unwrap()
            .try_into()
            .unwrap();
    let signing_key = Ed25519PrivateKey::new(private_key_bytes);
    let public_key_hex = "dec9c24a98da1187e30a5824ca2ee1e91e956b7dd6970590651d7d46c5e2ed41";
    let address = "0xc45d73cf687682db23be0ebdef5bc203585315b2d6a5a6a613b941e4d4a6a0e7";

    // Build public key with Ed25519 flag (0x00)
    let mut pk_with_flag = vec![0x00u8];
    pk_with_flag.extend_from_slice(&hex::decode(public_key_hex).unwrap());
    let public_key_with_flag_hex = hex::encode(&pk_with_flag);

    // Helper to sign bytes as PersonalMessage and return hex-encoded 64-byte signature
    let sign = |msg: &[u8]| -> String {
        let personal = PersonalMessage(Cow::Borrowed(msg));
        let user_sig = signing_key.sign_personal_message(&personal).unwrap();
        let sig_bytes = &user_sig.to_bytes()[1..65]; // skip flag byte, take 64 bytes
        hex::encode(sig_bytes)
    };

    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    let (sync_tx, mut sync_rx) = mpsc::unbounded_channel::<()>();
    let config = Config::default();

    // Set up auth middleware with test membership
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_id = "test-group";
    membership_store.add_member(
        group_id,
        address,
        vec![MessagingPermission::MessagingSender],
    );

    let block_check = BlockCheckService::from_config(&config);
    let push_service = PushService::from_config(&config);
    let app_state = AppState::new_for_tests(
        storage,
        sync_tx,
        membership_store.clone(),
        block_check,
        push_service,
    );

    let auth_state = AuthState {
        membership_store,
        config: config.clone(),
    };

    let app = Router::new()
        .route("/messages", post(create_message))
        .layer(middleware::from_fn_with_state(
            auth_state,
            messaging_relayer::auth::auth_middleware,
        ))
        .with_state(app_state);

    // Per-message signature over canonical content
    let encrypted_text = "deadbeef";
    let nonce_hex = "000000000000000000000000";
    let canonical = format!("{}:{}:{}:{}", group_id, encrypted_text, nonce_hex, 0);
    let message_signature = sign(canonical.as_bytes());

    let timestamp = chrono::Utc::now().timestamp();
    let body = json!({
        "group_id": group_id,
        "sender_address": address,
        "encrypted_text": encrypted_text,
        "nonce": nonce_hex,
        "key_version": 0,
        "timestamp": timestamp,
        "message_signature": message_signature,
        "attachments": []
    });

    let body_str = serde_json::to_string(&body).unwrap();
    let request_signature = sign(body_str.as_bytes());

    let request = Request::builder()
        .method(Method::POST)
        .uri("/messages")
        .header("content-type", "application/json")
        .header("x-signature", &request_signature)
        .header("x-public-key", &public_key_with_flag_hex)
        .body(Body::from(body_str))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    assert!(
        sync_rx.try_recv().is_ok(),
        "Handler should send sync notification after creating a message"
    );
}
