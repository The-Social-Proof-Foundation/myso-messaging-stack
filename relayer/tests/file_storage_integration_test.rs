//! Integration tests for the File Storage HTTP client using wiremock.
//! These tests mock the File Storage publisher/aggregator API locally,
//! so they run offline without hitting the real File Storage testnet.

use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

use messaging_relayer::file_storage::{FileStorageClient, FileStorageError};

/// Starts a wiremock server and creates a FileStorageClient pointing at it.
async fn setup() -> (MockServer, FileStorageClient) {
    let mock_server = MockServer::start().await;
    let client = FileStorageClient::new(mock_server.uri(), mock_server.uri());
    (mock_server, client)
}

/// JSON for a QuiltStoreResponse with the given patch identifiers.
fn quilt_store_response_json(identifiers: &[&str]) -> serde_json::Value {
    let patches: Vec<serde_json::Value> = identifiers
        .iter()
        .enumerate()
        .map(|(i, id)| {
            serde_json::json!({
                "identifier": id,
                "quiltPatchId": format!("mock-patch-id-{}", i),
            })
        })
        .collect();

    serde_json::json!({
        "blobStoreResult": {
            "newlyCreated": {
                "blobObject": {
                    "blobId": "mock-blob-id-001",
                    "id": "mock-object-id-001",
                    "size": 1024
                },
                "cost": 100
            }
        },
        "storedQuiltBlobs": patches
    })
}

/// JSON for a BlobStoreResponse (single blob).
fn blob_store_response_json() -> serde_json::Value {
    serde_json::json!({
        "newlyCreated": {
            "blobObject": {
                "blobId": "mock-single-blob-id",
                "id": "mock-object-id",
                "size": 256
            },
            "cost": 50
        }
    })
}

// Test 1: Store quilt and verify response parsing

#[tokio::test]
async fn test_store_quilt_and_verify_response() {
    let (mock_server, client) = setup().await;

    // Mock the PUT /v1/quilts endpoint
    Mock::given(method("PUT"))
        .and(path_regex(r"^/v1/quilts.*"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(quilt_store_response_json(&[
                "msg-uuid1",
                "msg-uuid2",
                "msg-uuid3",
            ])),
        )
        .mount(&mock_server)
        .await;

    let patches: Vec<(String, Vec<u8>)> = vec![
        ("msg-uuid1".to_string(), vec![1, 2, 3]),
        ("msg-uuid2".to_string(), vec![4, 5, 6]),
        ("msg-uuid3".to_string(), vec![7, 8, 9]),
    ];

    let response = client
        .store_quilt(patches, None, 1)
        .await
        .expect("store_quilt should succeed");

    // Verify response structure
    assert!(
        response.blob_store_result.newly_created.is_some()
            || response.blob_store_result.already_certified.is_some()
    );

    assert_eq!(response.stored_quilt_blobs.len(), 3);

    for patch in &response.stored_quilt_blobs {
        assert!(!patch.identifier.is_empty());
        assert!(!patch.quilt_patch_id.is_empty());
    }

    // Verify get_patch_id helper
    assert!(response.get_patch_id("msg-uuid1").is_some());
    assert!(response.get_patch_id("msg-uuid2").is_some());
    assert!(response.get_patch_id("msg-uuid3").is_some());
}

// Test 2: Quilt store then read back patches

#[tokio::test]
async fn test_quilt_patch_roundtrip() {
    let (mock_server, client) = setup().await;

    let bytes1 = vec![0xDE, 0xAD, 0xBE, 0xEF];
    let bytes2 = vec![0xCA, 0xFE, 0xBA, 0xBE];

    // Mock store_quilt
    Mock::given(method("PUT"))
        .and(path_regex(r"^/v1/quilts.*"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(quilt_store_response_json(&["msg-rt1", "msg-rt2"])),
        )
        .mount(&mock_server)
        .await;

    // Mock read_by_patch_id for patch 0 (msg-rt1)
    Mock::given(method("GET"))
        .and(path("/v1/blobs/by-quilt-patch-id/mock-patch-id-0"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes1.clone()))
        .mount(&mock_server)
        .await;

    // Mock read_by_patch_id for patch 1 (msg-rt2)
    Mock::given(method("GET"))
        .and(path("/v1/blobs/by-quilt-patch-id/mock-patch-id-1"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes2.clone()))
        .mount(&mock_server)
        .await;

    // Store
    let response = client
        .store_quilt(
            vec![
                ("msg-rt1".to_string(), bytes1.clone()),
                ("msg-rt2".to_string(), bytes2.clone()),
            ],
            None,
            1,
        )
        .await
        .expect("store_quilt should succeed");

    // Read back and verify
    let patch_id1 = response
        .get_patch_id("msg-rt1")
        .expect("Should have patch ID for msg-rt1");
    let read_bytes1 = client
        .read_by_patch_id(patch_id1)
        .await
        .expect("read_by_patch_id should succeed");
    assert_eq!(read_bytes1, bytes1);

    let patch_id2 = response
        .get_patch_id("msg-rt2")
        .expect("Should have patch ID for msg-rt2");
    let read_bytes2 = client
        .read_by_patch_id(patch_id2)
        .await
        .expect("read_by_patch_id should succeed");
    assert_eq!(read_bytes2, bytes2);
}

// Test 3: Single blob store and read

#[tokio::test]
async fn test_blob_store_and_read_roundtrip() {
    let (mock_server, client) = setup().await;

    let data = vec![0x01, 0x02, 0x03, 0x04];

    // Mock store_blob
    Mock::given(method("PUT"))
        .and(path_regex(r"^/v1/blobs.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(blob_store_response_json()))
        .mount(&mock_server)
        .await;

    // Mock read_blob
    Mock::given(method("GET"))
        .and(path("/v1/blobs/mock-single-blob-id"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(data.clone()))
        .mount(&mock_server)
        .await;

    let store_response = client
        .store_blob(data.clone(), 1)
        .await
        .expect("store_blob should succeed");

    let blob_id = store_response
        .blob_id()
        .expect("Response should contain a blob_id");

    let read_bytes = client
        .read_blob(blob_id)
        .await
        .expect("read_blob should succeed");

    assert_eq!(read_bytes, data);
}

// Test 4: List patches in quilt

#[tokio::test]
async fn test_list_patches_in_quilt() {
    let (mock_server, client) = setup().await;

    // Mock store_quilt
    Mock::given(method("PUT"))
        .and(path_regex(r"^/v1/quilts.*"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(quilt_store_response_json(&[
                "msg-list1",
                "msg-list2",
                "msg-list3",
            ])),
        )
        .mount(&mock_server)
        .await;

    // Mock list_patches — returns flat JSON array (File Storage API quirk)
    let patches_json = serde_json::json!([
        { "identifier": "msg-list1", "patch_id": "mock-patch-id-0", "tags": {} },
        { "identifier": "msg-list2", "patch_id": "mock-patch-id-1", "tags": {} },
        { "identifier": "msg-list3", "patch_id": "mock-patch-id-2", "tags": {} },
    ]);

    Mock::given(method("GET"))
        .and(path_regex(r"^/v1/quilts/.+/patches$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(patches_json))
        .mount(&mock_server)
        .await;

    // Store first to get a quilt blob ID
    let response = client
        .store_quilt(
            vec![
                ("msg-list1".to_string(), vec![1]),
                ("msg-list2".to_string(), vec![2]),
                ("msg-list3".to_string(), vec![3]),
            ],
            None,
            1,
        )
        .await
        .expect("store_quilt should succeed");

    let quilt_blob_id = response
        .quilt_blob_id()
        .expect("Response should have a quilt blob ID");

    // List patches
    let patch_list = client
        .list_patches(quilt_blob_id)
        .await
        .expect("list_patches should succeed");

    assert_eq!(patch_list.len(), 3);

    for patch in &patch_list {
        assert!(!patch.identifier.is_empty());
        assert!(!patch.patch_id.is_empty());
    }

    let identifiers: Vec<&str> = patch_list.iter().map(|p| p.identifier.as_str()).collect();
    assert!(identifiers.contains(&"msg-list1"));
    assert!(identifiers.contains(&"msg-list2"));
    assert!(identifiers.contains(&"msg-list3"));
}

// Test 5: Non-existent patch returns error

#[tokio::test]
async fn test_read_nonexistent_patch_returns_error() {
    let (mock_server, client) = setup().await;

    // Mock a 404 response
    Mock::given(method("GET"))
        .and(path(
            "/v1/blobs/by-quilt-patch-id/nonexistent-patch-id-12345",
        ))
        .respond_with(ResponseTemplate::new(404))
        .mount(&mock_server)
        .await;

    let result = client.read_by_patch_id("nonexistent-patch-id-12345").await;

    assert!(result.is_err());

    match result.unwrap_err() {
        FileStorageError::NotFound(_) => {}
        FileStorageError::ApiError { .. } => {}
        other => panic!("Expected NotFound or ApiError, got: {:?}", other),
    }
}

// Test 6: get_patch_id helper

#[tokio::test]
async fn test_get_patch_id_helper() {
    let (mock_server, client) = setup().await;

    Mock::given(method("PUT"))
        .and(path_regex(r"^/v1/quilts.*"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(quilt_store_response_json(&["msg-known-id", "msg-other-id"])),
        )
        .mount(&mock_server)
        .await;

    let response = client
        .store_quilt(
            vec![
                ("msg-known-id".to_string(), vec![1, 2]),
                ("msg-other-id".to_string(), vec![3, 4]),
            ],
            None,
            1,
        )
        .await
        .expect("store_quilt should succeed");

    // Known identifier should return Some with a non-empty patch ID
    let patch_id = response.get_patch_id("msg-known-id");
    assert!(patch_id.is_some());
    assert!(!patch_id.unwrap().is_empty());

    // Unknown identifier should return None
    let missing = response.get_patch_id("msg-unknown-id");
    assert!(missing.is_none());
}
