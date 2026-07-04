//! E2e: checkpoint sync -> workflow store -> REST list/badge.

mod support;

use std::borrow::Cow;
use std::sync::Arc;

use axum::http::{Method, Request, StatusCode};
use axum::middleware;
use axum::routing::get;
use axum::{body::Body, Router};
use myso_crypto::{ed25519::Ed25519PrivateKey, MySoSigner};
use myso_sdk_types::PersonalMessage;
use tokio::sync::mpsc;
use tower::ServiceExt;

use messaging_relayer::auth::{wallet_auth_middleware, AuthState};
use messaging_relayer::config::Config;
use messaging_relayer::handlers::workflow::{list_workflow_items, workflow_badge};
use messaging_relayer::services::block_check::BlockCheckService;
use messaging_relayer::services::message_gate::MessageGateService;
use messaging_relayer::services::push::PushService;
use messaging_relayer::services::AttributionVerifyService;
use messaging_relayer::services::RealtimeHub;
use messaging_relayer::state::AppState;
use messaging_relayer::storage::NoOpAgentGroupStore;

use support::sync_harness::{
    make_checkpoint_response, make_org_invitation_created_event, start_mock_server,
    SyncTestHarness,
};

const ED25519_PRIVATE_KEY: &str =
    "4ac9bd5399f7b41da4f00ec612c4e6521a1c756c41578ed5c15133f96ab9ea78";
const ED25519_PUBLIC_KEY: &str = "dec9c24a98da1187e30a5824ca2ee1e91e956b7dd6970590651d7d46c5e2ed41";
const ED25519_ADDRESS: &str = "0xc45d73cf687682db23be0ebdef5bc203585315b2d6a5a6a613b941e4d4a6a0e7";

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

fn signed_wallet_get(uri: &str) -> Request<Body> {
    let timestamp = chrono::Utc::now().timestamp();
    let public_key_with_flag = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);
    let canonical = format!("{timestamp}:{ED25519_ADDRESS}");
    let signature = sign_bytes_ed25519(canonical.as_bytes());

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

fn invitee_bytes() -> [u8; 32] {
    let raw = ED25519_ADDRESS.trim_start_matches("0x");
    let decoded = hex::decode(raw).unwrap();
    decoded.try_into().unwrap()
}

#[tokio::test]
async fn org_invitation_chain_sync_visible_via_workflow_api() {
    let org_id = [0xb1u8; 32];
    let account_id = [0xb2u8; 32];
    let invitee = invitee_bytes();
    let invited_by = [0xb4u8; 32];

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
    let push = PushService::from_config(&Config::default());
    let harness = SyncTestHarness::new(&format!("http://{addr}"), true, push);

    let mut service = harness.build_sync_service();
    service.run_subscription().await.unwrap();

    let (sync_tx, _sync_rx) = mpsc::unbounded_channel();
    let app_state = AppState::new(
        harness.storage_trait(),
        sync_tx,
        harness.membership_store.clone(),
        Arc::new(NoOpAgentGroupStore),
        harness.workflow_store_trait(),
        true,
        AttributionVerifyService::from_config(&Config::default()),
        BlockCheckService::from_config(&Config::default()),
        MessageGateService::from_config(&Config::default()),
        messaging_relayer::services::fallback_messaging_config_cache(),
        PushService::from_config(&Config::default()),
        Arc::new(RealtimeHub::new()),
        true,
        true,
        30,
        900,
    );

    let auth_state = AuthState {
        membership_store: harness.membership_store.clone(),
        config: harness.config.clone(),
    };

    let app = Router::new()
        .route("/v1/workflow/items", get(list_workflow_items))
        .route("/v1/workflow/badge", get(workflow_badge))
        .layer(middleware::from_fn_with_state(
            auth_state,
            wallet_auth_middleware,
        ))
        .with_state(app_state);

    let list_response = app
        .clone()
        .oneshot(signed_wallet_get("/v1/workflow/items"))
        .await
        .unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
    let list_body = response_json(list_response).await;
    assert_eq!(list_body["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        list_body["items"][0]["item_type"].as_str().unwrap(),
        "org_invitation"
    );
    assert_eq!(list_body["items"][0]["status"].as_str().unwrap(), "open");

    let badge_response = app
        .oneshot(signed_wallet_get("/v1/workflow/badge"))
        .await
        .unwrap();
    assert_eq!(badge_response.status(), StatusCode::OK);
    let badge_body = response_json(badge_response).await;
    assert_eq!(badge_body["open_count"].as_i64().unwrap(), 1);
}
