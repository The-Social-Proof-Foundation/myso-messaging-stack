//! E2EE M4: two wallet-certified MLS devices talk through the relayer delivery service.
//! KeyPackages -> claim -> create group -> commit (one per epoch) -> Welcome -> MLS-wrapped message.

use std::borrow::Cow;
use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
    middleware,
    routing::{get, post},
    Router,
};
use myso_crypto::{ed25519::Ed25519PrivateKey, MySoSigner};
use myso_mls::{Device, DeviceCertificate, DeviceKeys, Processed};
use myso_sdk_types::PersonalMessage;
use serde_json::{json, Value};
use tower::ServiceExt;

use messaging_relayer::{
    auth::{
        signature::derive_myso_address, schemes::SignatureScheme, wallet_middleware::wallet_auth_middleware,
        AuthState, InMemoryMembershipStore, MembershipStore, MessagingPermission,
    },
    config::Config,
    handlers::{messages::{create_message, get_messages}, mls},
    services::block_check::BlockCheckService,
    services::push::PushService,
    state::AppState,
    storage::{create_storage, StorageType},
};

const GROUP: &str = "0x00000000000000000000000000000000000000000000000000000000000000c1";

struct Wallet {
    key: Ed25519PrivateKey,
    address: String,
}

impl Wallet {
    fn new(seed: u8) -> Self {
        let key = Ed25519PrivateKey::new([seed; 32]);
        let address = derive_myso_address(key.public_key().as_bytes(), SignatureScheme::Ed25519).unwrap();
        Self { key, address }
    }

    fn sign(&self, message: &[u8]) -> String {
        let sig = self.key.sign_personal_message(&PersonalMessage(Cow::Borrowed(message))).unwrap().to_bytes();
        hex::encode(&sig[1..65])
    }

    fn pubkey(&self) -> String {
        format!("00{}", hex::encode(self.key.public_key().as_bytes()))
    }

    /// A device whose MLS identity is this wallet's signed certificate.
    fn device(&self, device_id: &str) -> (Device, DeviceCertificate) {
        let keys = DeviceKeys::generate().unwrap();
        let mls_key = hex::encode(keys.public_key());
        let issued = 1_700_000_000_000;
        let canonical = DeviceCertificate::canonical(&self.address, device_id, &mls_key, issued);
        let cert = DeviceCertificate {
            v: 1,
            wallet: self.address.clone(),
            device_id: device_id.into(),
            mls_key,
            issued_at_ms: issued,
            sig: self.sign(canonical.as_bytes()),
            signer_key: self.pubkey(),
            authority_key: None,
        };
        (Device::from_keys(keys, &cert.to_identity()).unwrap(), cert)
    }
}

fn app(members: &[&str]) -> Router {
    let membership = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    for m in members {
        membership.add_member(
            GROUP,
            m,
            vec![MessagingPermission::MessagingSender, MessagingPermission::MessagingReader],
        );
    }
    let config = Config::default();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let state = AppState::new_for_tests(
        create_storage(StorageType::InMemory),
        tx,
        membership.clone(),
        BlockCheckService::from_config(&config),
        PushService::from_config(&config),
    );
    let auth = AuthState { membership_store: membership, config };
    let group_routes = Router::new()
        .route("/messages", get(get_messages).post(create_message))
        .route("/v1/groups/:group_id/mls/welcomes", post(mls::post_welcome))
        .route("/v1/groups/:group_id/mls/group-info", get(mls::get_group_info).post(mls::put_group_info))
        .layer(middleware::from_fn_with_state(auth.clone(), messaging_relayer::auth::auth_middleware))
        .with_state(state.clone());
    let wallet_routes = Router::new()
        .route("/v1/mls/self/group-info", get(mls::get_self_group_info).put(mls::put_self_group_info))
        .route("/v1/mls/self/messages", get(mls::get_self_messages).post(mls::post_self_message))
        .route("/v1/mls/devices", get(mls::list_devices))
        .route("/v1/mls/backup/segments", get(mls::get_backup_segments).post(mls::post_backup_segment))
        .route("/v1/mls/devices/:device_id", axum::routing::delete(mls::delete_device))
        .route("/v1/mls/key-packages", post(mls::put_key_packages))
        .route("/v1/mls/key-packages/claim", post(mls::claim_key_packages))
        .route("/v1/mls/welcomes", get(mls::take_welcomes))
        .layer(middleware::from_fn_with_state(auth, wallet_auth_middleware))
        .with_state(state);
    Router::new().merge(group_routes).merge(wallet_routes)
}

async fn send(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = http_body_util::BodyExt::collect(response.into_body()).await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn post_signed(app: &Router, wallet: &Wallet, uri: &str, mut body: Value) -> (StatusCode, Value) {
    body["sender_address"] = json!(wallet.address);
    body["timestamp"] = json!(chrono::Utc::now().timestamp());
    if uri == "/messages" || uri.contains("/groups/") {
        body["group_id"] = json!(GROUP);
    }
    let raw = serde_json::to_string(&body).unwrap();
    let request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", "application/json")
        .header("x-signature", wallet.sign(raw.as_bytes()))
        .header("x-public-key", wallet.pubkey())
        .body(Body::from(raw))
        .unwrap();
    send(app, request).await
}

async fn put_signed(app: &Router, wallet: &Wallet, uri: &str, mut body: Value) -> (StatusCode, Value) {
    body["sender_address"] = json!(wallet.address);
    body["timestamp"] = json!(chrono::Utc::now().timestamp());
    if uri.contains("/groups/") {
        body["group_id"] = json!(GROUP);
    }
    let raw = serde_json::to_string(&body).unwrap();
    let request = Request::builder()
        .method(Method::PUT)
        .uri(uri)
        .header("content-type", "application/json")
        .header("x-signature", wallet.sign(raw.as_bytes()))
        .header("x-public-key", wallet.pubkey())
        .body(Body::from(raw))
        .unwrap();
    send(app, request).await
}

async fn get_signed(app: &Router, wallet: &Wallet, uri: &str, group: Option<&str>) -> (StatusCode, Value) {
    let ts = chrono::Utc::now().timestamp();
    let canonical = match group {
        Some(g) => format!("{ts}:{}:{g}", wallet.address),
        None => format!("{ts}:{}", wallet.address),
    };
    let mut builder = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .header("x-signature", wallet.sign(canonical.as_bytes()))
        .header("x-public-key", wallet.pubkey())
        .header("x-sender-address", &wallet.address)
        .header("x-timestamp", ts.to_string());
    if let Some(g) = group {
        builder = builder.header("x-group-id", g);
    }
    send(app, builder.body(Body::empty()).unwrap()).await
}

/// POST an MLS blob as a message-log row (`kind` = commit / message), wallet-signed like any row.
async fn post_row(app: &Router, wallet: &Wallet, kind: &str, mls: &[u8]) -> StatusCode {
    let enc = hex::encode(mls);
    let nonce = hex::encode(rand::random::<[u8; 12]>());
    let canonical = format!("{GROUP}:{kind}:{enc}:{nonce}:0");
    post_signed(app, wallet, "/messages", json!({
        "encrypted_text": enc, "nonce": nonce, "key_version": 0, "kind": kind,
        "message_signature": wallet.sign(canonical.as_bytes()),
    }))
    .await
    .0
}

#[tokio::test]
async fn two_devices_join_and_talk_through_the_relayer() {
    let alice = Wallet::new(7);
    let bob = Wallet::new(9);
    let app = app(&[&alice.address, &bob.address]);
    let (alice_dev, _) = alice.device("alice-phone");
    let (bob_dev, bob_cert) = bob.device("bob-phone");

    // Bob publishes KeyPackages under his wallet-signed certificate.
    let kps: Vec<String> = (0..2).map(|_| hex::encode(bob_dev.key_package().unwrap())).collect();
    let (status, _) = post_signed(&app, &bob, "/v1/mls/key-packages", json!({
        "device_id": "bob-phone", "certificate": bob_cert, "key_packages": kps,
    }))
    .await;
    assert_eq!(status, StatusCode::OK);

    // Alice claims one, creates the MLS group bound to the on-chain group id, adds Bob.
    let (status, claimed) = post_signed(&app, &alice, "/v1/mls/key-packages/claim", json!({ "wallets": [bob.address] })).await;
    assert_eq!(status, StatusCode::OK);
    let kp = hex::decode(claimed["items"][0]["key_package"].as_str().unwrap()).unwrap();
    let mut alice_group = alice_dev.create_group(GROUP.as_bytes()).unwrap();
    let (commit, welcome) = alice_group.add_members(&alice_dev, &[kp]).unwrap();

    // Exactly one commit per epoch.
    assert_eq!(post_row(&app, &alice, "commit", &commit).await, StatusCode::CREATED);
    assert_eq!(post_row(&app, &alice, "commit", &commit).await, StatusCode::CONFLICT);

    // Welcome goes to Bob's device; he fetches it once.
    let (status, _) = post_signed(&app, &alice, &format!("/v1/groups/{GROUP}/mls/welcomes"), json!({
        "recipients": [{ "wallet": bob.address, "device_id": "bob-phone" }],
        "welcome": hex::encode(&welcome),
    }))
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, welcomes) = get_signed(&app, &bob, "/v1/mls/welcomes?device_id=bob-phone", None).await;
    let welcome = hex::decode(welcomes["items"][0]["welcome"].as_str().unwrap()).unwrap();
    let mut bob_group = bob_dev.join(&welcome).unwrap();
    let (_, again) = get_signed(&app, &bob, "/v1/mls/welcomes?device_id=bob-phone", None).await;
    assert!(again["items"].as_array().unwrap().is_empty());

    // Bob sees Alice's certified wallet in the tree.
    let wallets: Vec<String> = bob_group.members().iter().filter_map(|m| m.certificate()).map(|c| c.wallet).collect();
    assert!(wallets.contains(&alice.address));

    // Alice sends an MLS-wrapped message row; Bob reads it from the relayer and decrypts.
    let ct = alice_group.encrypt(&alice_dev, b"DEK-sealed envelope").unwrap();
    assert_eq!(post_row(&app, &alice, "message", &ct).await, StatusCode::CREATED);
    let (_, page) = get_signed(&app, &bob, &format!("/messages?group_id={GROUP}&limit=10"), Some(GROUP)).await;
    let rows = page["messages"].as_array().unwrap();
    assert!(rows.iter().any(|r| r["kind"] == "commit"), "commit is in the ordered log");
    let row = rows.iter().find(|r| r["kind"] == "message").unwrap();
    let bytes = hex::decode(row["encrypted_text"].as_str().unwrap()).unwrap();
    match bob_group.process(&bob_dev, &bytes).unwrap() {
        Processed::Application { plaintext, .. } => assert_eq!(plaintext, b"DEK-sealed envelope"),
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn key_packages_need_a_valid_wallet_certificate() {
    let alice = Wallet::new(7);
    let mallory = Wallet::new(11);
    let app = app(&[&alice.address]);
    // Mallory certifies a device as Alice: signature by the wrong wallet.
    let (dev, mut cert) = mallory.device("x");
    cert.wallet = alice.address.clone();
    let (status, _) = post_signed(&app, &alice, "/v1/mls/key-packages", json!({
        "device_id": "x", "certificate": cert, "key_packages": [hex::encode(dev.key_package().unwrap())],
    }))
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn key_packages_accept_v2_authority_certificates() {
    let alice = Wallet::new(7);
    let mallory = Wallet::new(11);
    let app = app(&[&alice.address]);
    let keys = DeviceKeys::generate().unwrap();
    let mls_key = hex::encode(keys.public_key());
    let authority = DeviceKeys::generate().unwrap();
    let cert = DeviceCertificate::issue_v2(&authority, &alice.address, "v2", &mls_key, 1_700_000_000_000).unwrap();
    let dev = Device::from_keys(keys, &cert.to_identity()).unwrap();
    let kp = hex::encode(dev.key_package().unwrap());
    let (status, body) = post_signed(&app, &alice, "/v1/mls/key-packages", json!({
        "device_id": "v2", "certificate": cert, "key_packages": [kp.clone()],
    }))
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // A v2 certificate for Alice can't be uploaded by Mallory.
    let (status, _) = post_signed(&app, &mallory, "/v1/mls/key-packages", json!({
        "device_id": "v2", "certificate": cert, "key_packages": [kp.clone()],
    }))
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // A forged authority signature is rejected.
    let mut forged = cert.clone();
    forged.mls_key = hex::encode([3u8; 32]);
    let (status, _) = post_signed(&app, &alice, "/v1/mls/key-packages", json!({
        "device_id": "v2", "certificate": forged, "key_packages": [kp],
    }))
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn devices_report_last_activity_per_wallet() {
    let alice = Wallet::new(7);
    let bob = Wallet::new(9);
    let app = app(&[&alice.address, &bob.address]);
    for device in ["alice-phone", "alice-laptop"] {
        let (status, _) = get_signed(&app, &alice, &format!("/v1/mls/welcomes?device_id={device}"), None).await;
        assert_eq!(status, StatusCode::OK);
    }
    let (_, _) = get_signed(&app, &bob, "/v1/mls/welcomes?device_id=bob-phone", None).await;
    let (status, body) = get_signed(&app, &alice, "/v1/mls/devices", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut ids: Vec<String> = body["items"].as_array().unwrap().iter().map(|d| d["device_id"].as_str().unwrap().to_string()).collect();
    ids.sort();
    assert_eq!(ids, vec!["alice-laptop", "alice-phone"], "only the caller's devices");
    assert!(body["items"][0]["last_seen_ms"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn backup_segments_are_private_ordered_and_validated() {
    let alice = Wallet::new(7);
    let bob = Wallet::new(9);
    let app = app(&[&alice.address, &bob.address]);
    let key = "00112233445566778899aabbccddeeff";
    for body in ["aa01", "aa02"] {
        let (status, res) = post_signed(&app, &alice, "/v1/mls/backup/segments", json!({ "key_id": key, "body": body })).await;
        assert_eq!(status, StatusCode::OK, "{res}");
    }
    let (_, res) = get_signed(&app, &alice, &format!("/v1/mls/backup/segments?key_id={key}"), None).await;
    let bodies: Vec<&str> = res["items"].as_array().unwrap().iter().map(|i| i["body"].as_str().unwrap()).collect();
    assert_eq!(bodies, vec!["aa01", "aa02"]);
    // Bob can't see Alice's segments, even under the same key id.
    let (_, res) = get_signed(&app, &bob, &format!("/v1/mls/backup/segments?key_id={key}"), None).await;
    assert!(res["items"].as_array().unwrap().is_empty());
    // Bad key id / empty body rejected.
    let (status, _) = post_signed(&app, &alice, "/v1/mls/backup/segments", json!({ "key_id": "nothex!", "body": "aa" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = post_signed(&app, &alice, "/v1/mls/backup/segments", json!({ "key_id": key, "body": "" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// Pull every log row of `kind` after `after_order` (bytes, order).
async fn rows(app: &Router, wallet: &Wallet, kind: &str) -> Vec<Vec<u8>> {
    let (_, page) = get_signed(app, wallet, &format!("/messages?group_id={GROUP}&limit=50"), Some(GROUP)).await;
    page["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["kind"] == kind)
        .map(|r| hex::decode(r["encrypted_text"].as_str().unwrap()).unwrap())
        .collect()
}

#[tokio::test]
async fn new_device_joins_syncs_history_and_logs_out() {
    let alice = Wallet::new(7);
    let bob = Wallet::new(9);
    let app = app(&[&alice.address, &bob.address]);
    let (alice_dev, _) = alice.device("alice-phone");
    let (bob_phone, _) = bob.device("bob-phone");
    let (bob_laptop, _) = bob.device("bob-laptop");

    // Alice's group with Bob's phone (as in M4), then she publishes GroupInfo for epoch 1.
    let mut ag = alice_dev.create_group(GROUP.as_bytes()).unwrap();
    let (commit, welcome) = ag.add_members(&alice_dev, &[bob_phone.key_package().unwrap()]).unwrap();
    assert_eq!(post_row(&app, &alice, "commit", &commit).await, StatusCode::CREATED);
    let mut bg = bob_phone.join(&welcome).unwrap();
    let (status, _) = post_signed(&app, &alice, &format!("/v1/groups/{GROUP}/mls/group-info"), json!({
        "group_info": hex::encode(ag.group_info(&alice_dev).unwrap()),
    })).await;
    assert_eq!(status, StatusCode::OK);

    // Bob's laptop (an on-chain member's new device) fetches GroupInfo and joins on its own.
    let (status, info) = get_signed(&app, &bob, &format!("/v1/groups/{GROUP}/mls/group-info"), Some(GROUP)).await;
    assert_eq!(status, StatusCode::OK);
    let info = hex::decode(info["group_info"].as_str().unwrap()).unwrap();
    let (mut lg, join_commit) = bob_laptop.join_external(&info).unwrap();
    assert_eq!(post_row(&app, &bob, "commit", &join_commit).await, StatusCode::CREATED);
    for c in rows(&app, &alice, "commit").await.into_iter().skip(1) {
        ag.process(&alice_dev, &c).unwrap();
        bg.process(&bob_phone, &c).unwrap();
    }
    assert_eq!(ag.member_count(), 3);
    let ct = ag.encrypt(&alice_dev, b"to all three").unwrap();
    assert!(matches!(lg.process(&bob_laptop, &ct).unwrap(), Processed::Application { .. }));

    // History sync over Bob's self-group: phone creates it, laptop joins externally.
    let self_id = format!("self:{}", bob.address);
    let mut phone_self = bob_phone.create_group(self_id.as_bytes()).unwrap();
    let (status, _) = put_signed(&app, &bob, "/v1/mls/self/group-info", json!({
        "group_info": hex::encode(phone_self.group_info(&bob_phone).unwrap()),
    })).await;
    assert_eq!(status, StatusCode::OK);
    let (_, sinfo) = get_signed(&app, &bob, "/v1/mls/self/group-info", None).await;
    let (mut laptop_self, self_commit) =
        bob_laptop.join_external(&hex::decode(sinfo["group_info"].as_str().unwrap()).unwrap()).unwrap();
    let (status, _) = post_signed(&app, &bob, "/v1/mls/self/messages", json!({ "body": hex::encode(&self_commit) })).await;
    assert_eq!(status, StatusCode::OK);
    // Alice can't post into Bob's self-group.
    let (status, _) = post_signed(&app, &alice, "/v1/mls/self/messages", json!({ "body": hex::encode(&self_commit) })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (_, log) = get_signed(&app, &bob, "/v1/mls/self/messages?after=0", None).await;
    let first = hex::decode(log["items"][0]["body"].as_str().unwrap()).unwrap();
    phone_self.process(&bob_phone, &first).unwrap();
    let history = b"[{\"message_id\":\"m1\",\"text\":\"old chat\"}]".repeat(3000);
    for chunk in myso_mls::history::split("h1", &history) {
        let ct = phone_self.encrypt(&bob_phone, &chunk).unwrap();
        post_signed(&app, &bob, "/v1/mls/self/messages", json!({ "body": hex::encode(ct) })).await;
    }
    let (_, log) = get_signed(&app, &bob, "/v1/mls/self/messages?after=1", None).await;
    let mut assembler = myso_mls::history::Reassembler::default();
    let mut got = None;
    for item in log["items"].as_array().unwrap() {
        let bytes = hex::decode(item["body"].as_str().unwrap()).unwrap();
        if let Processed::Application { plaintext, .. } = laptop_self.process(&bob_laptop, &bytes).unwrap() {
            if let Some(done) = myso_mls::history::parse_chunk(&plaintext).and_then(|c| assembler.push(c)) {
                got = Some(done.1);
            }
        }
    }
    assert_eq!(got.as_deref(), Some(&history[..]), "laptop rebuilt the phone's history");

    // Logout: the laptop proposes its own removal, Alice commits it, its KeyPackages go away.
    let proposal = lg.leave(&bob_laptop).unwrap();
    assert_eq!(post_row(&app, &bob, "commit", &proposal).await, StatusCode::CREATED);
    ag.process(&alice_dev, &proposal).unwrap();
    let removal = ag.commit_pending(&alice_dev).unwrap().unwrap();
    assert_eq!(post_row(&app, &alice, "commit", &removal).await, StatusCode::CREATED);
    lg.process(&bob_laptop, &removal).unwrap();
    assert!(!lg.is_active());
    assert_eq!(ag.member_count(), 2);
    let ts = chrono::Utc::now().timestamp();
    // Wallet DELETEs sign the last path segment, binding the logged-out device id.
    let canonical = format!("{ts}:{}:bob-laptop", bob.address);
    let req = Request::builder()
        .method(Method::DELETE)
        .uri("/v1/mls/devices/bob-laptop")
        .header("x-signature", bob.sign(canonical.as_bytes()))
        .header("x-public-key", bob.pubkey())
        .header("x-sender-address", &bob.address)
        .header("x-timestamp", ts.to_string())
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&app, req).await.0, StatusCode::OK);
}
