//! Content envelope v2 relayer rules: opaque `message` / `event` rows, notify_wallets, paging.

use std::borrow::Cow;
use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
    middleware,
    routing::get,
    Router,
};
use myso_crypto::{ed25519::Ed25519PrivateKey, MySoSigner};
use myso_sdk_types::PersonalMessage;
use serde_json::{json, Value};
use tower::ServiceExt;

use messaging_relayer::{
    auth::{AuthState, InMemoryMembershipStore, MembershipStore, MessagingPermission},
    config::Config,
    handlers::messages::{create_message, get_messages},
    services::block_check::BlockCheckService,
    services::push::PushService,
    state::AppState,
    storage::{create_storage, StorageType},
};

const KEY: &str = "4ac9bd5399f7b41da4f00ec612c4e6521a1c756c41578ed5c15133f96ab9ea78";
const PUB: &str = "dec9c24a98da1187e30a5824ca2ee1e91e956b7dd6970590651d7d46c5e2ed41";
const ADDR: &str = "0xc45d73cf687682db23be0ebdef5bc203585315b2d6a5a6a613b941e4d4a6a0e7";
const PEER: &str = "0x00000000000000000000000000000000000000000000000000000000000000b0";
const GROUP: &str = "0xgroup_v2";

fn sign(message: &[u8]) -> String {
    let key = Ed25519PrivateKey::new(hex::decode(KEY).unwrap().try_into().unwrap());
    let sig = key
        .sign_personal_message(&PersonalMessage(Cow::Borrowed(message)))
        .unwrap()
        .to_bytes();
    hex::encode(&sig[1..65])
}

fn pubkey() -> String {
    format!("00{PUB}")
}

fn app() -> Router {
    let membership = Arc::new(InMemoryMembershipStore::new()) as Arc<dyn MembershipStore>;
    membership.add_member(
        GROUP,
        ADDR,
        vec![MessagingPermission::MessagingSender, MessagingPermission::MessagingReader],
    );
    membership.add_member(GROUP, PEER, vec![MessagingPermission::MessagingReader]);
    let config = Config::default();
    let (sync_tx, _rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let state = AppState::new_for_tests(
        create_storage(StorageType::InMemory),
        sync_tx,
        membership.clone(),
        BlockCheckService::from_config(&config),
        PushService::from_config(&config),
    );
    Router::new()
        .route("/messages", get(get_messages).post(create_message))
        .layer(middleware::from_fn_with_state(
            AuthState { membership_store: membership, config },
            messaging_relayer::auth::auth_middleware,
        ))
        .with_state(state)
}

async fn post(app: &Router, kind: &str, extra: Value) -> StatusCode {
    let nonce = hex::encode(rand::random::<[u8; 12]>());
    let enc = "deadbeef";
    let canonical = format!("{GROUP}:{kind}:{enc}:{nonce}:0");
    let mut body = json!({
        "group_id": GROUP,
        "encrypted_text": enc,
        "nonce": nonce,
        "key_version": 0,
        "kind": kind,
        "sender_address": ADDR,
        "timestamp": chrono::Utc::now().timestamp(),
        "message_signature": sign(canonical.as_bytes()),
    });
    if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    let raw = serde_json::to_string(&body).unwrap();
    let request = Request::builder()
        .method(Method::POST)
        .uri("/messages")
        .header("content-type", "application/json")
        .header("x-signature", sign(raw.as_bytes()))
        .header("x-public-key", pubkey())
        .body(Body::from(raw))
        .unwrap();
    app.clone().oneshot(request).await.unwrap().status()
}

async fn list(app: &Router, limit: usize) -> Value {
    let ts = chrono::Utc::now().timestamp();
    let request = Request::builder()
        .method(Method::GET)
        .uri(format!("/messages?group_id={GROUP}&limit={limit}"))
        .header("x-signature", sign(format!("{ts}:{ADDR}:{GROUP}").as_bytes()))
        .header("x-public-key", pubkey())
        .header("x-sender-address", ADDR)
        .header("x-timestamp", ts.to_string())
        .header("x-group-id", GROUP)
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = http_body_util::BodyExt::collect(response.into_body())
        .await
        .unwrap()
        .to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn accepts_opaque_message_and_event_rows() {
    let app = app();
    assert_eq!(post(&app, "message", json!({})).await, StatusCode::CREATED);
    assert_eq!(
        post(&app, "event", json!({ "notify_wallets": [PEER] })).await,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn rejects_relayer_visible_attachments_on_v2_rows() {
    let app = app();
    let att = json!({ "attachments": [{
        "storage_id": "s", "nonce": "00".repeat(12),
        "encrypted_metadata": "aa", "metadata_nonce": "00".repeat(12)
    }]});
    assert_eq!(post(&app, "message", att).await, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn notify_wallets_only_on_events() {
    let app = app();
    assert_eq!(
        post(&app, "message", json!({ "notify_wallets": [PEER] })).await,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn events_do_not_count_toward_the_page_limit() {
    let app = app();
    post(&app, "message", json!({})).await;
    for _ in 0..5 {
        post(&app, "event", json!({})).await;
    }
    let page = list(&app, 1).await;
    let rows = page["messages"].as_array().unwrap();
    assert_eq!(rows.len(), 6, "one message plus its five trailing events");
    assert_eq!(rows[0]["kind"], "message");
    assert!(rows[1..].iter().all(|r| r["kind"] == "event"));
    assert_eq!(page["hasNext"].as_bool().or(page["has_next"].as_bool()), Some(false));
}
