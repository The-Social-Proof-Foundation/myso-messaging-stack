//! Integration tests for the paid-DM gate: POST /messages enforcement (402
//! PAYMENT_REQUIRED) and the GET /v1/messaging/dm-gate advisory endpoint,
//! with myso-social-server mocked via wiremock.

use std::borrow::Cow;
use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
    middleware,
    routing::{get, post},
    Router,
};
use serde_json::json;
use myso_crypto::{ed25519::Ed25519PrivateKey, MySoSigner};
use myso_sdk_types::PersonalMessage;
use tower::ServiceExt;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use messaging_relayer::{
    auth::{
        auth_middleware, wallet_auth_middleware, AuthState, InMemoryMembershipStore,
        MembershipStore, MessagingPermission,
    },
    config::Config,
    handlers::dm_gate,
    handlers::messages::create_message,
    models::{Message, PaidEscrowRecord},
    services::block_check::BlockCheckService,
    services::message_gate::MessageGateService,
    services::push::PushService,
    state::AppState,
    storage::{InMemoryStorage, StorageAdapter},
};

/// Ed25519 test wallet (same fixture as auth_integration_test).
const ED25519_PRIVATE_KEY: &str =
    "4ac9bd5399f7b41da4f00ec612c4e6521a1c756c41578ed5c15133f96ab9ea78";
const ED25519_PUBLIC_KEY: &str = "dec9c24a98da1187e30a5824ca2ee1e91e956b7dd6970590651d7d46c5e2ed41";
const ED25519_ADDRESS: &str = "0xc45d73cf687682db23be0ebdef5bc203585315b2d6a5a6a613b941e4d4a6a0e7";

const RECIPIENT: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const THIRD_MEMBER: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";

// ==================== Helpers ====================

fn build_public_key_with_flag(flag: u8, pubkey_hex: &str) -> String {
    let mut result = vec![flag];
    result.extend_from_slice(&hex::decode(pubkey_hex).unwrap());
    hex::encode(result)
}

fn sign_bytes_ed25519(message: &[u8]) -> String {
    let private_key_bytes: [u8; 32] = hex::decode(ED25519_PRIVATE_KEY)
        .unwrap()
        .try_into()
        .unwrap();
    let signing_key = Ed25519PrivateKey::new(private_key_bytes);
    let personal_message = PersonalMessage(Cow::Borrowed(message));
    let user_signature = signing_key
        .sign_personal_message(&personal_message)
        .unwrap();
    hex::encode(&user_signature.to_bytes()[1..65])
}

fn gate_config(social_server_url: &str) -> Config {
    Config {
        social_server_url: Some(social_server_url.to_string()),
        paid_gate_enabled: true,
        // Block check stays disabled — these tests isolate the paid-DM gate.
        block_check_enabled: false,
        ..Config::default()
    }
}

struct GateTestApp {
    router: Router,
    storage: Arc<dyn StorageAdapter>,
}

/// Builds an app with POST /messages (group auth) and GET /v1/messaging/dm-gate
/// (wallet auth), wired to a MessageGateService pointing at the mock social server.
fn create_gate_test_app(
    config: &Config,
    membership_store: Arc<dyn MembershipStore>,
) -> GateTestApp {
    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    let (sync_tx, _rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let app_state = AppState::new_for_tests_with_gate(
        storage.clone(),
        sync_tx,
        membership_store.clone(),
        BlockCheckService::from_config(config),
        MessageGateService::from_config(config),
        PushService::from_config(config),
    );

    let auth_state = AuthState {
        membership_store,
        config: config.clone(),
    };

    let message_routes = Router::new()
        .route("/messages", post(create_message))
        .layer(middleware::from_fn_with_state(
            auth_state.clone(),
            auth_middleware,
        ))
        .with_state(app_state.clone());

    let wallet_routes = Router::new()
        .route("/v1/messaging/dm-gate", get(dm_gate::get_dm_gate))
        .layer(middleware::from_fn_with_state(
            auth_state,
            wallet_auth_middleware,
        ))
        .with_state(app_state);

    GateTestApp {
        router: Router::new().merge(message_routes).merge(wallet_routes),
        storage,
    }
}

/// Membership store with a 2-member DM: the ed25519 sender + RECIPIENT.
fn dm_membership(group_id: &str) -> Arc<dyn MembershipStore> {
    let store = Arc::new(InMemoryMembershipStore::new());
    store.add_member(
        group_id,
        ED25519_ADDRESS,
        vec![MessagingPermission::MessagingSender],
    );
    store.add_member(
        group_id,
        RECIPIENT,
        vec![MessagingPermission::MessagingReader],
    );
    store as Arc<dyn MembershipStore>
}

/// Mocks `GET /social-graph/check/{sender}/{recipient}`.
async fn mock_follow_check(server: &MockServer, follower: &str, followee: &str, following: bool) {
    Mock::given(method("GET"))
        .and(path(format!(
            "/social-graph/check/{}/{}",
            follower, followee
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "is_following": following,
            "following_back": false,
        })))
        .mount(server)
        .await;
}

/// Mocks `GET /wallets/{wallet}/messaging-policy`; `None` mounts a 404 (no policy row).
async fn mock_policy(server: &MockServer, wallet: &str, policy: Option<(bool, Option<u64>)>) {
    let mock = Mock::given(method("GET")).and(path(format!("/wallets/{}/messaging-policy", wallet)));
    match policy {
        Some((enabled, min_cost)) => {
            mock.respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "wallet_address": wallet,
                "enabled": enabled,
                "min_cost": min_cost,
                "updated_at": 0,
            })))
            .mount(server)
            .await;
        }
        None => {
            mock.respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "error": "No messaging policy"
            })))
            .mount(server)
            .await;
        }
    }
}

fn signed_message_request(group_id: &str) -> Request<Body> {
    let timestamp = chrono::Utc::now().timestamp();
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);

    let encrypted_text = "deadbeef";
    let nonce_hex = {
        use rand::Rng;
        let bytes: [u8; 12] = rand::thread_rng().gen();
        hex::encode(bytes)
    };
    let canonical = format!("{}:{}:{}:{}", group_id, encrypted_text, nonce_hex, 0);
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

    Request::builder()
        .method(Method::POST)
        .uri("/messages")
        .header("content-type", "application/json")
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .body(Body::from(body_str))
        .unwrap()
}

fn signed_dm_gate_request(recipient: &str, group_id: Option<&str>) -> Request<Body> {
    let timestamp = chrono::Utc::now().timestamp();
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);
    let canonical = format!("{}:{}", timestamp, ED25519_ADDRESS);
    let signature = sign_bytes_ed25519(canonical.as_bytes());

    let uri = match group_id {
        Some(gid) => format!(
            "/v1/messaging/dm-gate?recipient={}&group_id={}",
            recipient, gid
        ),
        None => format!("/v1/messaging/dm-gate?recipient={}", recipient),
    };

    Request::builder()
        .method(Method::GET)
        .uri(uri)
        .header("x-signature", &signature)
        .header("x-public-key", &public_key_with_flag)
        .header("x-sender-address", ED25519_ADDRESS)
        .header("x-timestamp", timestamp.to_string())
        .body(Body::empty())
        .unwrap()
}

async fn response_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = http_body_util::BodyExt::collect(response.into_body())
        .await
        .unwrap()
        .to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

fn escrow(group_id: &str, seq: i64, payer: &str, recipient: &str, amount: i64) -> PaidEscrowRecord {
    PaidEscrowRecord {
        group_id: group_id.to_string(),
        seq,
        payer: payer.to_string(),
        recipient: recipient.to_string(),
        amount,
        created_at_ms: 0,
    }
}

fn seeded_message(group_id: &str, sender: &str, nonce_tag: u8) -> Message {
    let mut nonce = vec![0u8; 12];
    nonce[0] = nonce_tag;
    Message::new(
        group_id.to_string(),
        sender.to_string(),
        vec![1, 2, 3],
        nonce,
        0,
        vec![],
        vec![0u8; 64],
        vec![0u8; 33],
    )
}

// ==================== POST /messages enforcement ====================

#[tokio::test]
async fn first_message_to_paid_recipient_without_escrow_returns_402() {
    let social = MockServer::start().await;
    mock_follow_check(&social, ED25519_ADDRESS, RECIPIENT, false).await;
    mock_policy(&social, RECIPIENT, Some((true, Some(100)))).await;

    let group_id = "0xgroup_paid_gate";
    let config = gate_config(&social.uri());
    let app = create_gate_test_app(&config, dm_membership(group_id));

    let response = app
        .router
        .clone()
        .oneshot(signed_message_request(group_id))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);

    let body = response_json(response).await;
    assert_eq!(body["code"], "PAYMENT_REQUIRED");
    assert_eq!(body["min_cost"], "100");
    assert_eq!(body["recipient"], RECIPIENT);
}

#[tokio::test]
async fn first_message_allowed_after_escrow_indexed() {
    let social = MockServer::start().await;
    mock_follow_check(&social, ED25519_ADDRESS, RECIPIENT, false).await;
    mock_policy(&social, RECIPIENT, Some((true, Some(100)))).await;

    let group_id = "0xgroup_paid_escrowed";
    let config = gate_config(&social.uri());
    let app = create_gate_test_app(&config, dm_membership(group_id));

    // Simulate the checkpoint indexer having recorded the on-chain escrow.
    app.storage
        .record_paid_escrow(escrow(group_id, 0, ED25519_ADDRESS, RECIPIENT, 100))
        .await
        .unwrap();

    let response = app
        .router
        .clone()
        .oneshot(signed_message_request(group_id))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn first_message_allowed_when_following_recipient() {
    let social = MockServer::start().await;
    mock_follow_check(&social, ED25519_ADDRESS, RECIPIENT, true).await;
    mock_policy(&social, RECIPIENT, Some((true, Some(100)))).await;

    let group_id = "0xgroup_follower";
    let config = gate_config(&social.uri());
    let app = create_gate_test_app(&config, dm_membership(group_id));

    let response = app
        .router
        .clone()
        .oneshot(signed_message_request(group_id))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn subsequent_outbound_message_is_not_gated() {
    let social = MockServer::start().await;
    mock_follow_check(&social, ED25519_ADDRESS, RECIPIENT, false).await;
    mock_policy(&social, RECIPIENT, Some((true, Some(100)))).await;

    let group_id = "0xgroup_second_send";
    let config = gate_config(&social.uri());
    let app = create_gate_test_app(&config, dm_membership(group_id));

    // Sender already has an outbound message in this group.
    app.storage
        .create_message(seeded_message(group_id, ED25519_ADDRESS, 1))
        .await
        .unwrap();

    let response = app
        .router
        .clone()
        .oneshot(signed_message_request(group_id))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn reply_allowed_when_peer_has_messaged() {
    let social = MockServer::start().await;
    mock_follow_check(&social, ED25519_ADDRESS, RECIPIENT, false).await;
    mock_policy(&social, RECIPIENT, Some((true, Some(100)))).await;

    let group_id = "0xgroup_peer_sent_first";
    let config = gate_config(&social.uri());
    let app = create_gate_test_app(&config, dm_membership(group_id));

    // The peer already messaged — the conversation is open (on-chain
    // `next_seq != 0` semantics), so the sender's reply is never gated.
    app.storage
        .create_message(seeded_message(group_id, RECIPIENT, 2))
        .await
        .unwrap();

    let response = app
        .router
        .clone()
        .oneshot(signed_message_request(group_id))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn reply_allowed_when_peer_paid_sender() {
    let social = MockServer::start().await;
    mock_follow_check(&social, ED25519_ADDRESS, RECIPIENT, false).await;
    mock_policy(&social, RECIPIENT, Some((true, Some(100)))).await;

    let group_id = "0xgroup_peer_escrowed";
    let config = gate_config(&social.uri());
    let app = create_gate_test_app(&config, dm_membership(group_id));

    // The peer opened this conversation with a paid escrow to the sender.
    // Replying must be free (it is how the escrow gets claimed on-chain).
    app.storage
        .record_paid_escrow(escrow(group_id, 0, RECIPIENT, ED25519_ADDRESS, 100))
        .await
        .unwrap();

    let response = app
        .router
        .clone()
        .oneshot(signed_message_request(group_id))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn recipient_without_policy_is_not_gated() {
    let social = MockServer::start().await;
    mock_follow_check(&social, ED25519_ADDRESS, RECIPIENT, false).await;
    mock_policy(&social, RECIPIENT, None).await;

    let group_id = "0xgroup_no_policy";
    let config = gate_config(&social.uri());
    let app = create_gate_test_app(&config, dm_membership(group_id));

    let response = app
        .router
        .clone()
        .oneshot(signed_message_request(group_id))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn disabled_policy_is_not_gated() {
    let social = MockServer::start().await;
    mock_follow_check(&social, ED25519_ADDRESS, RECIPIENT, false).await;
    mock_policy(&social, RECIPIENT, Some((false, Some(100)))).await;

    let group_id = "0xgroup_disabled_policy";
    let config = gate_config(&social.uri());
    let app = create_gate_test_app(&config, dm_membership(group_id));

    let response = app
        .router
        .clone()
        .oneshot(signed_message_request(group_id))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn multi_member_group_is_not_gated() {
    let social = MockServer::start().await;
    // No social-server mocks needed — the gate must skip non-DM groups entirely.

    let group_id = "0xgroup_three_members";
    let store = Arc::new(InMemoryMembershipStore::new());
    store.add_member(
        group_id,
        ED25519_ADDRESS,
        vec![MessagingPermission::MessagingSender],
    );
    store.add_member(
        group_id,
        RECIPIENT,
        vec![MessagingPermission::MessagingReader],
    );
    store.add_member(
        group_id,
        THIRD_MEMBER,
        vec![MessagingPermission::MessagingReader],
    );

    let config = gate_config(&social.uri());
    let app = create_gate_test_app(&config, store as Arc<dyn MembershipStore>);

    let response = app
        .router
        .clone()
        .oneshot(signed_message_request(group_id))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn social_server_failure_fails_closed() {
    let social = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&social)
        .await;

    let group_id = "0xgroup_social_down";
    let config = gate_config(&social.uri());
    let app = create_gate_test_app(&config, dm_membership(group_id));

    let response = app
        .router
        .clone()
        .oneshot(signed_message_request(group_id))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

// ==================== GET /v1/messaging/dm-gate ====================

#[tokio::test]
async fn dm_gate_endpoint_reports_payment_required() {
    let social = MockServer::start().await;
    mock_follow_check(&social, ED25519_ADDRESS, RECIPIENT, false).await;
    mock_policy(&social, RECIPIENT, Some((true, Some(250)))).await;

    let config = gate_config(&social.uri());
    let app = create_gate_test_app(&config, Arc::new(InMemoryMembershipStore::new()));

    let response = app
        .router
        .clone()
        .oneshot(signed_dm_gate_request(RECIPIENT, None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = response_json(response).await;
    assert_eq!(body["allowed"], false);
    assert_eq!(body["reason"], "PAYMENT_REQUIRED");
    assert_eq!(body["blocked"], false);
    assert_eq!(body["following"], false);
    assert_eq!(body["paid"], false);
    assert_eq!(body["peer_paid"], false);
    assert_eq!(body["min_cost"], "250");
    assert_eq!(body["recipient"], RECIPIENT);
}

#[tokio::test]
async fn dm_gate_endpoint_allows_follower() {
    let social = MockServer::start().await;
    mock_follow_check(&social, ED25519_ADDRESS, RECIPIENT, true).await;
    mock_policy(&social, RECIPIENT, Some((true, Some(250)))).await;

    let config = gate_config(&social.uri());
    let app = create_gate_test_app(&config, Arc::new(InMemoryMembershipStore::new()));

    let response = app
        .router
        .clone()
        .oneshot(signed_dm_gate_request(RECIPIENT, None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = response_json(response).await;
    assert_eq!(body["allowed"], true);
    assert_eq!(body["reason"], serde_json::Value::Null);
    assert_eq!(body["following"], true);
}

#[tokio::test]
async fn dm_gate_endpoint_reports_paid_for_group_with_escrow() {
    let social = MockServer::start().await;
    mock_follow_check(&social, ED25519_ADDRESS, RECIPIENT, false).await;
    mock_policy(&social, RECIPIENT, Some((true, Some(250)))).await;

    let group_id = "0xgroup_gate_paid";
    let config = gate_config(&social.uri());
    let app = create_gate_test_app(&config, Arc::new(InMemoryMembershipStore::new()));

    app.storage
        .record_paid_escrow(escrow(group_id, 0, ED25519_ADDRESS, RECIPIENT, 250))
        .await
        .unwrap();

    let response = app
        .router
        .clone()
        .oneshot(signed_dm_gate_request(RECIPIENT, Some(group_id)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = response_json(response).await;
    assert_eq!(body["allowed"], true);
    assert_eq!(body["paid"], true);
    assert_eq!(body["reason"], serde_json::Value::Null);
}

#[tokio::test]
async fn dm_gate_endpoint_reports_peer_paid_for_reply() {
    let social = MockServer::start().await;
    mock_follow_check(&social, ED25519_ADDRESS, RECIPIENT, false).await;
    mock_policy(&social, RECIPIENT, Some((true, Some(250)))).await;

    let group_id = "0xgroup_gate_peer_paid";
    let config = gate_config(&social.uri());
    let app = create_gate_test_app(&config, Arc::new(InMemoryMembershipStore::new()));

    // The peer escrowed to the caller: the caller's reply is free and the
    // advisory response carries the claimable amount.
    app.storage
        .record_paid_escrow(escrow(group_id, 0, RECIPIENT, ED25519_ADDRESS, 250))
        .await
        .unwrap();

    let response = app
        .router
        .clone()
        .oneshot(signed_dm_gate_request(RECIPIENT, Some(group_id)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = response_json(response).await;
    assert_eq!(body["allowed"], true);
    assert_eq!(body["reason"], serde_json::Value::Null);
    assert_eq!(body["peer_paid"], true);
    assert_eq!(body["peer_escrow_amount"], "250");
    assert_eq!(body["first_outbound"], true);
}

#[tokio::test]
async fn dm_gate_endpoint_requires_wallet_auth() {
    let social = MockServer::start().await;
    let config = gate_config(&social.uri());
    let app = create_gate_test_app(&config, Arc::new(InMemoryMembershipStore::new()));

    let request = Request::builder()
        .method(Method::GET)
        .uri(format!("/v1/messaging/dm-gate?recipient={}", RECIPIENT))
        .body(Body::empty())
        .unwrap();

    let response = app.router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

// ==================== Chain-event cache refresh ====================

#[tokio::test]
async fn policy_cache_refreshes_from_chain_event_without_http() {
    let social = MockServer::start().await;
    // Social server still reports the stale "disabled" policy.
    mock_policy(&social, RECIPIENT, Some((false, None))).await;

    let config = gate_config(&social.uri());
    let gate = MessageGateService::from_config(&config);

    // Initial fetch caches the social-server value.
    let policy = gate.paid_policy(RECIPIENT).await.unwrap().unwrap();
    assert!(!policy.enabled);

    // Checkpoint indexer sees PaidMessagingPolicyUpdated — chain truth wins
    // immediately, without waiting for the social-server indexer.
    gate.apply_policy_update(RECIPIENT, true, Some(500));

    let policy = gate.paid_policy(RECIPIENT).await.unwrap().unwrap();
    assert!(policy.enabled);
    assert_eq!(policy.min_cost, Some(500));
}

#[tokio::test]
async fn follow_cache_refreshes_from_chain_event_without_http() {
    let social = MockServer::start().await;
    mock_follow_check(&social, ED25519_ADDRESS, RECIPIENT, false).await;

    let config = gate_config(&social.uri());
    let gate = MessageGateService::from_config(&config);

    assert!(!gate.is_following(ED25519_ADDRESS, RECIPIENT).await.unwrap());

    // FollowEvent lands in a checkpoint.
    gate.apply_follow_update(ED25519_ADDRESS, RECIPIENT, true);
    assert!(gate.is_following(ED25519_ADDRESS, RECIPIENT).await.unwrap());

    // UnfollowEvent flips it back.
    gate.apply_follow_update(ED25519_ADDRESS, RECIPIENT, false);
    assert!(!gate.is_following(ED25519_ADDRESS, RECIPIENT).await.unwrap());
}
