//! Integration tests for the authentication middleware.
//! These tests verify the full request flow through Axum using test wallets.

use std::borrow::Cow;
use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
    middleware,
    routing::{delete, get},
    Router,
};
use rstest::rstest;
use serde_json::json;
use myso_crypto::{
    ed25519::Ed25519PrivateKey, secp256k1::Secp256k1PrivateKey, secp256r1::Secp256r1PrivateKey,
    MySoSigner,
};
use myso_sdk_types::PersonalMessage;
use tower::ServiceExt;

use messaging_relayer::{
    auth::{AuthState, InMemoryMembershipStore, MembershipStore, MessagingPermission},
    config::Config,
    handlers::health::health_check,
    handlers::messages::{create_message, delete_message, get_messages, update_message},
    state::AppState,
    storage::{create_storage, StorageType},
};

/// Ed25519 wallet:
const ED25519_PRIVATE_KEY: &str =
    "4ac9bd5399f7b41da4f00ec612c4e6521a1c756c41578ed5c15133f96ab9ea78";
const ED25519_PUBLIC_KEY: &str = "dec9c24a98da1187e30a5824ca2ee1e91e956b7dd6970590651d7d46c5e2ed41";
const ED25519_ADDRESS: &str = "0xc45d73cf687682db23be0ebdef5bc203585315b2d6a5a6a613b941e4d4a6a0e7";

/// Secp256k1 wallet
const SECP256K1_PRIVATE_KEY: &str =
    "6ae98ba75c281c5ea3fb80f06f5f1afd8a6b69ec2a02186c73c928d67c96cd4b";
const SECP256K1_PUBLIC_KEY: &str =
    "024324a9c68113352194ff0b8bca673e6d01f67e97f80a827ee9ce898119da9f86";
const SECP256K1_ADDRESS: &str =
    "0x87ee5d74c3e7ae5145072943685451dfd71a8e911c04f0d90e636ec7d6483543";

/// Secp256r1 wallet
const SECP256R1_PRIVATE_KEY: &str =
    "7e944e7562603f3a6a0d799ca760d9e113de997da5b6915f70716fb371efae90";
const SECP256R1_PUBLIC_KEY: &str =
    "027951b52f60955a34eaac3bb75d086d1c431e45a9b44d0730d29db84ec148511e";
const SECP256R1_ADDRESS: &str =
    "0x1f4283b353e5d5086bff6b7b68c4149a8c284fa53b0ca34a48cdfb407c6c2c09";

// ==================== Test Helpers ====================

fn create_test_app(membership_store: Arc<dyn MembershipStore>) -> Router {
    // Use default config for tests - doesn't require environment variables
    let config = Config::default();
    let storage = create_storage(StorageType::InMemory);
    let (sync_tx, _rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let app_state = AppState::new(storage, config.clone(), sync_tx);

    let auth_state = AuthState {
        membership_store,
        config: config.clone(),
    };

    // All message routes require authentication (GET, POST, PUT, DELETE)
    let authenticated_routes = Router::new()
        .route(
            "/messages",
            get(get_messages).post(create_message).put(update_message),
        )
        .route("/messages/:message_id", delete(delete_message))
        .layer(middleware::from_fn_with_state(
            auth_state,
            messaging_relayer::auth::auth_middleware,
        ))
        .with_state(app_state.clone());

    // Health check is public
    let public_routes = Router::new()
        .route("/health_check", get(health_check))
        .with_state(app_state);

    Router::new()
        .merge(public_routes)
        .merge(authenticated_routes)
}

/// Build public key with flag: flag_byte || public_key_bytes
fn build_public_key_with_flag(flag: u8, pubkey_hex: &str) -> String {
    let mut result = vec![flag];
    result.extend_from_slice(&hex::decode(pubkey_hex).unwrap());
    hex::encode(result)
}

/// Extract raw signature bytes from a UserSignature.
/// UserSignature serializes as: flag (1 byte) || signature (64 bytes) || public_key
/// We extract bytes [1..65] to get the raw 64-byte signature.
fn extract_signature_bytes(user_sig_bytes: &[u8]) -> Vec<u8> {
    user_sig_bytes[1..65].to_vec()
}

/// Sign raw bytes with Ed25519 using official myso-crypto library.
/// Returns hex-encoded 64-byte signature.
fn sign_bytes_ed25519(message: &[u8]) -> String {
    let private_key_bytes: [u8; 32] = hex::decode(ED25519_PRIVATE_KEY)
        .unwrap()
        .try_into()
        .unwrap();
    let signing_key = Ed25519PrivateKey::new(private_key_bytes);

    // Sign the raw bytes as a MySo PersonalMessage
    let personal_message = PersonalMessage(Cow::Borrowed(message));
    let user_signature = signing_key
        .sign_personal_message(&personal_message)
        .unwrap();

    // Extract only the raw 64-byte signature (skip flag byte, exclude public key)
    hex::encode(extract_signature_bytes(&user_signature.to_bytes()))
}

/// Sign raw bytes with Secp256k1
fn sign_bytes_secp256k1(message: &[u8]) -> String {
    let private_key_bytes: [u8; 32] = hex::decode(SECP256K1_PRIVATE_KEY)
        .unwrap()
        .try_into()
        .unwrap();
    let signing_key = Secp256k1PrivateKey::new(private_key_bytes).unwrap();

    let personal_message = PersonalMessage(Cow::Borrowed(message));
    let user_signature = signing_key
        .sign_personal_message(&personal_message)
        .unwrap();

    hex::encode(extract_signature_bytes(&user_signature.to_bytes()))
}

/// Sign raw bytes with Secp256r1
fn sign_bytes_secp256r1(message: &[u8]) -> String {
    let private_key_bytes: [u8; 32] = hex::decode(SECP256R1_PRIVATE_KEY)
        .unwrap()
        .try_into()
        .unwrap();
    let signing_key = Secp256r1PrivateKey::new(private_key_bytes);

    let personal_message = PersonalMessage(Cow::Borrowed(message));
    let user_signature = signing_key
        .sign_personal_message(&personal_message)
        .unwrap();

    hex::encode(extract_signature_bytes(&user_signature.to_bytes()))
}

// ==================== Public Route Tests ====================

#[tokio::test]
async fn test_health_check_no_auth() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let app = create_test_app(membership_store);

    let request = Request::builder()
        .method(Method::GET)
        .uri("/health_check")
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_post_without_auth_fails() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let app = create_test_app(membership_store);

    // Send a POST without X-Signature header - should be rejected
    let body = json!({
        "group_id": "0xgroup123",
        "encrypted_text": "deadbeef",
        "nonce": "000000000000000000000000",
        "key_version": 0,
        "sender_address": "0xsender123",
        "timestamp": chrono::Utc::now().timestamp()
    });

    let request = Request::builder()
        .method(Method::POST)
        .uri("/messages")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_string(&body).unwrap()))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

// Signature Scheme Tests (parameterized)

#[rstest]
#[case("ed25519", 0x00, ED25519_PUBLIC_KEY, ED25519_ADDRESS, sign_bytes_ed25519 as fn(&[u8]) -> String)]
#[case("secp256k1", 0x01, SECP256K1_PUBLIC_KEY, SECP256K1_ADDRESS, sign_bytes_secp256k1 as fn(&[u8]) -> String)]
#[case("secp256r1", 0x02, SECP256R1_PUBLIC_KEY, SECP256R1_ADDRESS, sign_bytes_secp256r1 as fn(&[u8]) -> String)]
#[tokio::test]
async fn test_valid_auth_succeeds(
    #[case] scheme: &str,
    #[case] flag: u8,
    #[case] public_key: &str,
    #[case] address: &str,
    #[case] sign_fn: fn(&[u8]) -> String,
) {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_id = format!("0xgroup_{}", scheme);

    membership_store.add_member(
        &group_id,
        address,
        vec![MessagingPermission::MessagingSender],
    );

    let app = create_test_app(membership_store);
    let timestamp = chrono::Utc::now().timestamp();
    let public_key_with_flag = build_public_key_with_flag(flag, public_key);

    // Per-message signature over canonical content
    let encrypted_text = "deadbeef";
    let nonce_hex = "000000000000000000000000";
    let canonical = format!("{}:{}:{}:{}", group_id, encrypted_text, nonce_hex, 0);
    let message_signature = sign_fn(canonical.as_bytes());

    let body = json!({
        "group_id": group_id,
        "encrypted_text": encrypted_text,
        "nonce": nonce_hex,
        "key_version": 0,
        "sender_address": address,
        "timestamp": timestamp,
        "message_signature": message_signature
    });

    let body_str = serde_json::to_string(&body).unwrap();
    let signature = sign_fn(body_str.as_bytes());

    let request = Request::builder()
        .method(Method::POST)
        .uri("/messages")
        .header("content-type", "application/json")
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .body(Body::from(body_str))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
}

#[rstest]
#[case("ed25519", 0x00, ED25519_PUBLIC_KEY, ED25519_ADDRESS, sign_bytes_ed25519 as fn(&[u8]) -> String)]
#[case("secp256k1", 0x01, SECP256K1_PUBLIC_KEY, SECP256K1_ADDRESS, sign_bytes_secp256k1 as fn(&[u8]) -> String)]
#[case("secp256r1", 0x02, SECP256R1_PUBLIC_KEY, SECP256R1_ADDRESS, sign_bytes_secp256r1 as fn(&[u8]) -> String)]
#[tokio::test]
async fn test_no_permission_returns_403(
    #[case] _scheme: &str,
    #[case] flag: u8,
    #[case] public_key: &str,
    #[case] address: &str,
    #[case] sign_fn: fn(&[u8]) -> String,
) {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    // NOT adding the user to membership cache
    let app = create_test_app(membership_store);

    let group_id = "0xgroup_no_perm";
    let timestamp = chrono::Utc::now().timestamp();
    let public_key_with_flag = build_public_key_with_flag(flag, public_key);

    let body = json!({
        "group_id": group_id,
        "encrypted_text": "deadbeef",
        "nonce": "000000000000000000000000",
        "key_version": 0,
        "sender_address": address,
        "timestamp": timestamp
    });

    let body_str = serde_json::to_string(&body).unwrap();
    let signature = sign_fn(body_str.as_bytes());

    let request = Request::builder()
        .method(Method::POST)
        .uri("/messages")
        .header("content-type", "application/json")
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .body(Body::from(body_str))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

// ==================== Security Tests ====================

#[tokio::test]
async fn test_expired_timestamp_rejected() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_id = "0xgroup_expired";

    membership_store.add_member(
        group_id,
        ED25519_ADDRESS,
        vec![MessagingPermission::MessagingSender],
    );

    let app = create_test_app(membership_store);
    let config = Config::default();
    let expired_timestamp = chrono::Utc::now().timestamp() - config.request_ttl_seconds - 100;
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);

    let body = json!({
        "group_id": group_id,
        "encrypted_text": "deadbeef",
        "nonce": "000000000000000000000000",
        "key_version": 0,
        "sender_address": ED25519_ADDRESS,
        "timestamp": expired_timestamp
    });

    let body_str = serde_json::to_string(&body).unwrap();
    let signature = sign_bytes_ed25519(body_str.as_bytes());

    let request = Request::builder()
        .method(Method::POST)
        .uri("/messages")
        .header("content-type", "application/json")
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .body(Body::from(body_str))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_address_mismatch_rejected() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_id = "0xgroup_mismatch";

    // Use Ed25519 public key but claim Secp256k1 address
    let fake_address = SECP256K1_ADDRESS;

    membership_store.add_member(
        group_id,
        fake_address,
        vec![MessagingPermission::MessagingSender],
    );

    let app = create_test_app(membership_store);
    let timestamp = chrono::Utc::now().timestamp();
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);

    let body = json!({
        "group_id": group_id,
        "encrypted_text": "deadbeef",
        "nonce": "000000000000000000000000",
        "key_version": 0,
        "sender_address": fake_address,
        "timestamp": timestamp
    });

    let body_str = serde_json::to_string(&body).unwrap();
    let signature = sign_bytes_ed25519(body_str.as_bytes());

    let request = Request::builder()
        .method(Method::POST)
        .uri("/messages")
        .header("content-type", "application/json")
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .body(Body::from(body_str))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_invalid_signature_rejected() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_id = "0xgroup_invalid_sig";

    membership_store.add_member(
        group_id,
        ED25519_ADDRESS,
        vec![MessagingPermission::MessagingSender],
    );

    let app = create_test_app(membership_store);
    let timestamp = chrono::Utc::now().timestamp();
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);

    let body = json!({
        "group_id": group_id,
        "encrypted_text": "deadbeef",
        "nonce": "000000000000000000000000",
        "key_version": 0,
        "sender_address": ED25519_ADDRESS,
        "timestamp": timestamp
    });

    let body_str = serde_json::to_string(&body).unwrap();

    // Sign with DIFFERENT wallet (secp256k1 key signing for ed25519 pubkey)
    let wrong_signature = sign_bytes_secp256k1(body_str.as_bytes());

    let request = Request::builder()
        .method(Method::POST)
        .uri("/messages")
        .header("content-type", "application/json")
        .header("x-signature", &wrong_signature)
        .header("x-public-key", &public_key_with_flag)
        .body(Body::from(body_str))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

// ==================== GET Auth Tests (bodyless) ====================

#[tokio::test]
async fn test_get_messages_requires_auth() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let app = create_test_app(membership_store);

    // GET without auth headers should be rejected
    let request = Request::builder()
        .method(Method::GET)
        .uri("/messages?group_id=0xgroup123")
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_get_messages_with_valid_auth_succeeds() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_id = "0xgroup_reader";

    membership_store.add_member(
        group_id,
        ED25519_ADDRESS,
        vec![MessagingPermission::MessagingReader],
    );

    let app = create_test_app(membership_store);
    let timestamp = chrono::Utc::now().timestamp();
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);

    // For bodyless requests, sign the canonical string: "timestamp:sender_address:group_id"
    let canonical = format!("{}:{}:{}", timestamp, ED25519_ADDRESS, group_id);
    let signature = sign_bytes_ed25519(canonical.as_bytes());

    let request = Request::builder()
        .method(Method::GET)
        .uri(format!("/messages?group_id={}", group_id))
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .header("x-sender-address", ED25519_ADDRESS)
        .header("x-timestamp", timestamp.to_string())
        .header("x-group-id", group_id)
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

fn random_nonce_hex() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: [u8; 12] = rng.gen();
    hex::encode(bytes)
}

async fn create_message_as_ed25519(app: &Router, group_id: &str) -> uuid::Uuid {
    let timestamp = chrono::Utc::now().timestamp();
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);

    // Per-message signature over canonical content
    let encrypted_text = "deadbeef";
    let nonce_hex = random_nonce_hex();
    let canonical = format!("{}:{}:{}:{}", group_id, encrypted_text, &nonce_hex, 0);
    let message_signature = sign_bytes_ed25519(canonical.as_bytes());

    let body = json!({
        "group_id": group_id,
        "encrypted_text": encrypted_text,
        "nonce": nonce_hex,
        "key_version": 0,
        "sender_address": ED25519_ADDRESS,
        "timestamp": timestamp,
        "message_signature": message_signature
    });

    let body_str = serde_json::to_string(&body).unwrap();
    let signature = sign_bytes_ed25519(body_str.as_bytes());

    let request = Request::builder()
        .method(Method::POST)
        .uri("/messages")
        .header("content-type", "application/json")
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .body(Body::from(body_str))
        .unwrap();

    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    let body_bytes = http_body_util::BodyExt::collect(response.into_body())
        .await
        .unwrap()
        .to_bytes();
    let resp: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    uuid::Uuid::parse_str(resp["message_id"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn test_delete_own_message_succeeds() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_id = "0xgroup_delete_own";

    // Grant both Sender (to create) and Deleter (to delete) permissions
    membership_store.add_member(
        group_id,
        ED25519_ADDRESS,
        vec![
            MessagingPermission::MessagingSender,
            MessagingPermission::MessagingDeleter,
        ],
    );

    let app = create_test_app(membership_store);

    // Create a message as Ed25519 user
    let message_id = create_message_as_ed25519(&app, group_id).await;

    // Delete the message as the same user
    let timestamp = chrono::Utc::now().timestamp();
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);
    let canonical = format!("{}:{}:{}", timestamp, ED25519_ADDRESS, group_id);
    let signature = sign_bytes_ed25519(canonical.as_bytes());

    let request = Request::builder()
        .method(Method::DELETE)
        .uri(format!("/messages/{}", message_id))
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .header("x-sender-address", ED25519_ADDRESS)
        .header("x-timestamp", timestamp.to_string())
        .header("x-group-id", group_id)
        .body(Body::empty())
        .unwrap();

    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_delete_other_users_message_returns_403() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_id = "0xgroup_delete_other";

    membership_store.add_member(
        group_id,
        ED25519_ADDRESS,
        vec![MessagingPermission::MessagingSender],
    );

    membership_store.add_member(
        group_id,
        SECP256K1_ADDRESS,
        vec![MessagingPermission::MessagingDeleter],
    );

    let app = create_test_app(membership_store);

    // Create a message as Ed25519 user
    let message_id = create_message_as_ed25519(&app, group_id).await;

    // Try to delete as Secp256k1 user (different sender, should be rejected)
    let timestamp = chrono::Utc::now().timestamp();
    let public_key_with_flag = build_public_key_with_flag(0x01, SECP256K1_PUBLIC_KEY);
    let canonical = format!("{}:{}:{}", timestamp, SECP256K1_ADDRESS, group_id);
    let signature = sign_bytes_secp256k1(canonical.as_bytes());

    let request = Request::builder()
        .method(Method::DELETE)
        .uri(format!("/messages/{}", message_id))
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .header("x-sender-address", SECP256K1_ADDRESS)
        .header("x-timestamp", timestamp.to_string())
        .header("x-group-id", group_id)
        .body(Body::empty())
        .unwrap();

    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

// Replay Protection Tests

/// Sending the exact same POST request twice (same nonce) should be rejected as replay
#[tokio::test]
async fn test_replay_same_post_nonce_rejected() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_id = "0xgroup_replay";

    membership_store.add_member(
        group_id,
        ED25519_ADDRESS,
        vec![MessagingPermission::MessagingSender],
    );

    let app = create_test_app(membership_store);
    let timestamp = chrono::Utc::now().timestamp();
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);

    // Use a fixed nonce so both requests have the same one
    let nonce = "aabbccddeeff001122334455";
    let canonical = format!("{}:{}:{}:{}", group_id, "deadbeef", nonce, 0);
    let message_signature = sign_bytes_ed25519(canonical.as_bytes());
    let body = json!({
        "group_id": group_id,
        "encrypted_text": "deadbeef",
        "nonce": nonce,
        "key_version": 0,
        "sender_address": ED25519_ADDRESS,
        "timestamp": timestamp,
        "message_signature": message_signature
    });

    let body_str = serde_json::to_string(&body).unwrap();
    let signature = sign_bytes_ed25519(body_str.as_bytes());

    // First request — should succeed
    let request1 = Request::builder()
        .method(Method::POST)
        .uri("/messages")
        .header("content-type", "application/json")
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .body(Body::from(body_str.clone()))
        .unwrap();

    let response1 = app.clone().oneshot(request1).await.unwrap();
    assert_eq!(response1.status(), StatusCode::CREATED);

    // Second request with same nonce, should be rejected as replay (409 Conflict)
    let request2 = Request::builder()
        .method(Method::POST)
        .uri("/messages")
        .header("content-type", "application/json")
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .body(Body::from(body_str))
        .unwrap();

    let response2 = app.clone().oneshot(request2).await.unwrap();
    assert_eq!(response2.status(), StatusCode::CONFLICT);
}

/// Two POST requests with different nonces should both succeed.
#[tokio::test]
async fn test_different_nonces_both_accepted() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_id = "0xgroup_diff_nonce";

    membership_store.add_member(
        group_id,
        ED25519_ADDRESS,
        vec![MessagingPermission::MessagingSender],
    );

    let app = create_test_app(membership_store);
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);

    // First request with nonce A
    let timestamp1 = chrono::Utc::now().timestamp();
    let nonce1 = "aaaaaaaaaaaaaaaaaaaaaaaa";
    let canonical1 = format!("{}:{}:{}:{}", group_id, "deadbeef", nonce1, 0);
    let msg_sig1 = sign_bytes_ed25519(canonical1.as_bytes());
    let body1 = json!({
        "group_id": group_id,
        "encrypted_text": "deadbeef",
        "nonce": nonce1,
        "key_version": 0,
        "sender_address": ED25519_ADDRESS,
        "timestamp": timestamp1,
        "message_signature": msg_sig1
    });
    let body_str1 = serde_json::to_string(&body1).unwrap();
    let signature1 = sign_bytes_ed25519(body_str1.as_bytes());

    let request1 = Request::builder()
        .method(Method::POST)
        .uri("/messages")
        .header("content-type", "application/json")
        .header("x-signature", &signature1)
        .header("x-public-key", &public_key_with_flag)
        .body(Body::from(body_str1))
        .unwrap();

    let response1 = app.clone().oneshot(request1).await.unwrap();
    assert_eq!(response1.status(), StatusCode::CREATED);

    // Second request with nonce B (different nonce)
    let timestamp2 = chrono::Utc::now().timestamp();
    let nonce2 = "bbbbbbbbbbbbbbbbbbbbbbbb";
    let canonical2 = format!("{}:{}:{}:{}", group_id, "deadbeef", nonce2, 0);
    let msg_sig2 = sign_bytes_ed25519(canonical2.as_bytes());
    let body2 = json!({
        "group_id": group_id,
        "encrypted_text": "deadbeef",
        "nonce": nonce2,
        "key_version": 0,
        "sender_address": ED25519_ADDRESS,
        "timestamp": timestamp2,
        "message_signature": msg_sig2
    });
    let body_str2 = serde_json::to_string(&body2).unwrap();
    let signature2 = sign_bytes_ed25519(body_str2.as_bytes());

    let request2 = Request::builder()
        .method(Method::POST)
        .uri("/messages")
        .header("content-type", "application/json")
        .header("x-signature", &signature2)
        .header("x-public-key", &public_key_with_flag)
        .body(Body::from(body_str2))
        .unwrap();

    let response2 = app.clone().oneshot(request2).await.unwrap();
    assert_eq!(response2.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn test_get_replay_is_allowed() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_id = "0xgroup_get_replay";

    membership_store.add_member(
        group_id,
        ED25519_ADDRESS,
        vec![MessagingPermission::MessagingReader],
    );

    let app = create_test_app(membership_store);
    let timestamp = chrono::Utc::now().timestamp();
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);
    let canonical = format!("{}:{}:{}", timestamp, ED25519_ADDRESS, group_id);
    let signature = sign_bytes_ed25519(canonical.as_bytes());

    let request1 = Request::builder()
        .method(Method::GET)
        .uri(format!("/messages?group_id={}", group_id))
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .header("x-sender-address", ED25519_ADDRESS)
        .header("x-timestamp", timestamp.to_string())
        .header("x-group-id", group_id)
        .body(Body::empty())
        .unwrap();

    let response1 = app.clone().oneshot(request1).await.unwrap();
    assert_eq!(response1.status(), StatusCode::OK);

    let request2 = Request::builder()
        .method(Method::GET)
        .uri(format!("/messages?group_id={}", group_id))
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .header("x-sender-address", ED25519_ADDRESS)
        .header("x-timestamp", timestamp.to_string())
        .header("x-group-id", group_id)
        .body(Body::empty())
        .unwrap();

    let response2 = app.clone().oneshot(request2).await.unwrap();
    assert_eq!(response2.status(), StatusCode::OK);
}

// ==================== Cross-Group GET Tests ====================

/// Authorize for group A, but request messages from group B → 403
#[tokio::test]
async fn test_get_messages_cross_group_returns_403() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_a = "0xgroup_get_a";
    let group_b = "0xgroup_get_b";

    // User is a reader of group A only
    membership_store.add_member(
        group_a,
        ED25519_ADDRESS,
        vec![MessagingPermission::MessagingReader],
    );

    let app = create_test_app(membership_store);
    let timestamp = chrono::Utc::now().timestamp();
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);

    // Sign for group A (authorized)
    let canonical = format!("{}:{}:{}", timestamp, ED25519_ADDRESS, group_a);
    let signature = sign_bytes_ed25519(canonical.as_bytes());

    // But request messages from group B (not authorized)
    let request = Request::builder()
        .method(Method::GET)
        .uri(format!("/messages?group_id={}", group_b))
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .header("x-sender-address", ED25519_ADDRESS)
        .header("x-timestamp", timestamp.to_string())
        .header("x-group-id", group_a)
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

/// Authorize for group A, but fetch a single message from group B by ID → 403
#[tokio::test]
async fn test_get_message_by_id_cross_group_returns_403() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_a = "0xgroup_getid_a";
    let group_b = "0xgroup_getid_b";

    // User can create in group A, read from group B
    membership_store.add_member(
        group_a,
        ED25519_ADDRESS,
        vec![
            MessagingPermission::MessagingSender,
            MessagingPermission::MessagingReader,
        ],
    );
    membership_store.add_member(
        group_b,
        ED25519_ADDRESS,
        vec![MessagingPermission::MessagingReader],
    );

    let app = create_test_app(membership_store);

    // Create a message in group A
    let message_id = create_message_as_ed25519(&app, group_a).await;

    // Authenticate for group B, then try to fetch the message (which belongs to group A)
    let timestamp = chrono::Utc::now().timestamp();
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);
    let canonical = format!("{}:{}:{}", timestamp, ED25519_ADDRESS, group_b);
    let signature = sign_bytes_ed25519(canonical.as_bytes());

    let request = Request::builder()
        .method(Method::GET)
        .uri(format!("/messages?message_id={}", message_id))
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .header("x-sender-address", ED25519_ADDRESS)
        .header("x-timestamp", timestamp.to_string())
        .header("x-group-id", group_b)
        .body(Body::empty())
        .unwrap();

    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

// ==================== PUT Auth Tests ====================

/// Helper: builds a signed PUT /messages request body and returns (body_str, request_signature)
fn build_update_request(
    message_id: &uuid::Uuid,
    group_id: &str,
    address: &str,
    sign_fn: fn(&[u8]) -> String,
    public_key_with_flag: &str,
) -> Request<Body> {
    let timestamp = chrono::Utc::now().timestamp();
    let encrypted_text = "cafebabe";
    let nonce_hex = random_nonce_hex();
    let key_version = 1;

    // Per-message signature over canonical content
    let canonical = format!(
        "{}:{}:{}:{}",
        group_id, encrypted_text, nonce_hex, key_version
    );
    let message_signature = sign_fn(canonical.as_bytes());

    let body = json!({
        "message_id": message_id.to_string(),
        "group_id": group_id,
        "encrypted_text": encrypted_text,
        "nonce": nonce_hex,
        "key_version": key_version,
        "sender_address": address,
        "timestamp": timestamp,
        "message_signature": message_signature,
        "attachments": []
    });

    let body_str = serde_json::to_string(&body).unwrap();
    let request_signature = sign_fn(body_str.as_bytes());

    Request::builder()
        .method(Method::PUT)
        .uri("/messages")
        .header("content-type", "application/json")
        .header("x-signature", &request_signature)
        .header("x-public-key", public_key_with_flag)
        .body(Body::from(body_str))
        .unwrap()
}

#[tokio::test]
async fn test_update_own_message_succeeds() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_id = "0xgroup_update_own";

    // Grant Sender (to create) and Editor (to update) permissions
    membership_store.add_member(
        group_id,
        ED25519_ADDRESS,
        vec![
            MessagingPermission::MessagingSender,
            MessagingPermission::MessagingEditor,
        ],
    );

    let app = create_test_app(membership_store);
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);

    // Create a message first
    let message_id = create_message_as_ed25519(&app, group_id).await;

    // Update the message as the same user
    let request = build_update_request(
        &message_id,
        group_id,
        ED25519_ADDRESS,
        sign_bytes_ed25519,
        &public_key_with_flag,
    );

    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_update_cross_group_returns_403() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_a = "0xgroup_update_a";
    let group_b = "0xgroup_update_b";

    // User is a member of both groups
    membership_store.add_member(
        group_a,
        ED25519_ADDRESS,
        vec![
            MessagingPermission::MessagingSender,
            MessagingPermission::MessagingEditor,
        ],
    );
    membership_store.add_member(
        group_b,
        ED25519_ADDRESS,
        vec![MessagingPermission::MessagingEditor],
    );

    let app = create_test_app(membership_store);
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);

    // Create a message in group A
    let message_id = create_message_as_ed25519(&app, group_a).await;

    // Try to update the message while authenticated for group B (cross-group attack)
    let request = build_update_request(
        &message_id,
        group_b,
        ED25519_ADDRESS,
        sign_bytes_ed25519,
        &public_key_with_flag,
    );

    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn test_update_other_users_message_returns_403() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_id = "0xgroup_update_other";

    // Ed25519 user can create, Secp256k1 user can edit
    membership_store.add_member(
        group_id,
        ED25519_ADDRESS,
        vec![MessagingPermission::MessagingSender],
    );
    membership_store.add_member(
        group_id,
        SECP256K1_ADDRESS,
        vec![MessagingPermission::MessagingEditor],
    );

    let app = create_test_app(membership_store);
    let secp_pk_with_flag = build_public_key_with_flag(0x01, SECP256K1_PUBLIC_KEY);

    // Create a message as Ed25519 user
    let message_id = create_message_as_ed25519(&app, group_id).await;

    // Try to update as Secp256k1 user (different sender)
    let request = build_update_request(
        &message_id,
        group_id,
        SECP256K1_ADDRESS,
        sign_bytes_secp256k1,
        &secp_pk_with_flag,
    );

    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

// ==================== Cross-Group DELETE Tests ====================

#[tokio::test]
async fn test_delete_cross_group_returns_403() {
    let membership_store = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    let group_a = "0xgroup_delete_a";
    let group_b = "0xgroup_delete_b";

    // User is a member of both groups
    membership_store.add_member(
        group_a,
        ED25519_ADDRESS,
        vec![
            MessagingPermission::MessagingSender,
            MessagingPermission::MessagingDeleter,
        ],
    );
    membership_store.add_member(
        group_b,
        ED25519_ADDRESS,
        vec![MessagingPermission::MessagingDeleter],
    );

    let app = create_test_app(membership_store);
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);

    // Create a message in group A
    let message_id = create_message_as_ed25519(&app, group_a).await;

    // Try to delete while authenticated for group B (cross-group attack)
    let timestamp = chrono::Utc::now().timestamp();
    let canonical = format!("{}:{}:{}", timestamp, ED25519_ADDRESS, group_b);
    let signature = sign_bytes_ed25519(canonical.as_bytes());

    let request = Request::builder()
        .method(Method::DELETE)
        .uri(format!("/messages/{}", message_id))
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .header("x-sender-address", ED25519_ADDRESS)
        .header("x-timestamp", timestamp.to_string())
        .header("x-group-id", group_b)
        .body(Body::empty())
        .unwrap();

    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
