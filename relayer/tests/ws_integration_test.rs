//! WebSocket integration tests (in-memory storage + RealtimeHub).

use std::borrow::Cow;
use std::sync::Arc;
use std::time::Duration;

use axum::{http::StatusCode, middleware, routing::get, Router};
use futures_util::StreamExt;
use messaging_relayer::{
    auth::{AuthState, InMemoryMembershipStore, MembershipStore, MessagingPermission},
    config::Config,
    handlers::messages::{create_message, get_messages},
    handlers::ws::ws_handler,
    services::block_check::BlockCheckService,
    services::push::PushService,
    state::AppState,
    storage::{create_storage, StorageType},
};
use myso_crypto::{ed25519::Ed25519PrivateKey, MySoSigner};
use myso_sdk_types::PersonalMessage;
use serde_json::Value;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const ED25519_PRIVATE_KEY: &str =
    "4ac9bd5399f7b41da4f00ec612c4e6521a1c756c41578ed5c15133f96ab9ea78";
const ED25519_PUBLIC_KEY: &str = "dec9c24a98da1187e30a5824ca2ee1e91e956b7dd6970590651d7d46c5e2ed41";
const ED25519_ADDRESS: &str = "0xc45d73cf687682db23be0ebdef5bc203585315b2d6a5a6a613b941e4d4a6a0e7";

const GROUP_ID: &str = "ws-test-group";
const ENCRYPTED_TEXT: &str = "cafebabe";

fn build_public_key_with_flag(flag: u8, pubkey_hex: &str) -> String {
    let mut result = vec![flag];
    result.extend_from_slice(&hex::decode(pubkey_hex).unwrap());
    hex::encode(result)
}

fn extract_signature_bytes(user_sig_bytes: &[u8]) -> Vec<u8> {
    user_sig_bytes[1..65].to_vec()
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
    hex::encode(extract_signature_bytes(&user_signature.to_bytes()))
}

fn ws_auth_query(group_id: &str, after_order: Option<i64>) -> String {
    let timestamp = chrono::Utc::now().timestamp();
    let canonical = format!("{timestamp}:{ED25519_ADDRESS}:{group_id}");
    let signature = sign_bytes_ed25519(canonical.as_bytes());
    let public_key = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);
    let mut query = format!(
        "group_id={group_id}&sender_address={ED25519_ADDRESS}&timestamp={timestamp}&signature={signature}&public_key={public_key}"
    );
    if let Some(order) = after_order {
        query.push_str(&format!("&after_order={order}"));
    }
    query
}

fn create_test_app(membership_store: Arc<dyn MembershipStore>) -> Router {
    let config = Config::default();
    let storage = create_storage(StorageType::InMemory);
    let (sync_tx, _rx) = tokio::sync::mpsc::unbounded_channel::<()>();
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

    let message_routes = Router::new()
        .route("/messages", get(get_messages).post(create_message))
        .layer(middleware::from_fn_with_state(
            auth_state.clone(),
            messaging_relayer::auth::auth_middleware,
        ))
        .with_state(app_state.clone());

    let realtime_routes = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(app_state.clone());

    Router::new()
        .merge(message_routes)
        .nest("/v1", realtime_routes)
}

async fn bind_test_server(app: Router) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let handle = tokio::spawn(async move {
        axum::serve(listener, app.into_make_service())
            .await
            .unwrap();
    });

    (port, handle)
}

async fn post_message(port: u16, group_id: &str) -> StatusCode {
    let timestamp = chrono::Utc::now().timestamp();
    let nonce = "000000000000000000000000";
    let canonical = format!("{group_id}:{ENCRYPTED_TEXT}:{nonce}:0");
    let message_signature = sign_bytes_ed25519(canonical.as_bytes());
    let body = serde_json::json!({
        "group_id": group_id,
        "sender_address": ED25519_ADDRESS,
        "timestamp": timestamp,
        "encrypted_text": ENCRYPTED_TEXT,
        "nonce": nonce,
        "key_version": 0,
        "message_signature": message_signature,
    });
    let body_str = serde_json::to_string(&body).unwrap();
    let signature = sign_bytes_ed25519(body_str.as_bytes());

    reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/messages"))
        .header("content-type", "application/json")
        .header("x-signature", signature)
        .header("x-public-key", build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY))
        .body(body_str)
        .send()
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn ws_delivers_full_encrypted_wire_payload() {
    let membership = Arc::new(InMemoryMembershipStore::new());
    membership.add_member(
        GROUP_ID,
        ED25519_ADDRESS,
        vec![
            MessagingPermission::MessagingSender,
            MessagingPermission::MessagingReader,
        ],
    );

    let app = create_test_app(membership);
    let (port, server) = bind_test_server(app).await;
    let ws_url = format!(
        "ws://127.0.0.1:{port}/v1/ws?{}",
        ws_auth_query(GROUP_ID, None)
    );

    let (mut ws, _) = connect_async(&ws_url).await.expect("ws connect");
    let ws_task = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(Ok(Message::Text(text))) = ws.next().await {
                let frame: Value = serde_json::from_str(&text).expect("json frame");
                if frame.get("type").and_then(|v| v.as_str()) == Some("message.created") {
                    let message = frame.get("message").expect("message field");
                    assert_eq!(
                        message
                            .get("encrypted_text")
                            .and_then(|v| v.as_str())
                            .unwrap(),
                        ENCRYPTED_TEXT
                    );
                    return;
                }
            }
            panic!("expected message.created frame");
        })
        .await
        .expect("timed out waiting for ws frame")
    });

    let status = post_message(port, GROUP_ID).await;
    assert_eq!(status, StatusCode::CREATED);

    ws_task.await.unwrap();
    server.abort();
}

#[tokio::test]
async fn ws_auth_rejects_bad_signature() {
    let membership = Arc::new(InMemoryMembershipStore::new());
    membership.add_member(
        GROUP_ID,
        ED25519_ADDRESS,
        vec![MessagingPermission::MessagingReader],
    );

    let app = create_test_app(membership);
    let (port, server) = bind_test_server(app).await;
    let ws_url = format!(
        "ws://127.0.0.1:{port}/v1/ws?group_id={GROUP_ID}&sender_address={ED25519_ADDRESS}&timestamp=1&signature=00&public_key={}",
        build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY)
    );

    let result = connect_async(&ws_url).await;
    assert!(result.is_err(), "bad signature should reject ws upgrade");
    server.abort();
}
