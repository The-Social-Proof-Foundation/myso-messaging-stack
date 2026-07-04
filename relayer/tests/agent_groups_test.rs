//! Integration tests for wallet-authenticated agent conversation discovery.

use std::borrow::Cow;
use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, StatusCode},
    middleware,
    routing::get,
    Router,
};
use chrono::Utc;
use myso_crypto::ed25519::Ed25519PrivateKey;
use myso_crypto::MySoSigner;
use myso_sdk_types::PersonalMessage;
use tower::ServiceExt;

use messaging_relayer::auth::{wallet_auth_middleware, AuthState, InMemoryMembershipStore};
use messaging_relayer::config::Config;
use messaging_relayer::handlers::agent_groups;
use messaging_relayer::models::AgentMessagingGroup;
use messaging_relayer::services::block_check::BlockCheckService;
use messaging_relayer::services::push::PushService;
use messaging_relayer::services::AttributionVerifyService;
use messaging_relayer::state::AppState;
use messaging_relayer::storage::{create_storage, AgentGroupStore, NoOpAgentGroupStore, StorageType};

const ED25519_PRIVATE_KEY: &str =
    "4ac9bd5399f7b41da4f00ec612c4e6521a1c756c41578ed5c15133f96ab9ea78";
const ED25519_PUBLIC_KEY: &str = "dec9c24a98da1187e30a5824ca2ee1e91e956b7dd6970590651d7d46c5e2ed41";
const ED25519_ADDRESS: &str = "0xc45d73cf687682db23be0ebdef5bc203585315b2d6a5a6a613b941e4d4a6a0e7";

struct RecordingAgentGroupStore {
    principal_rows: Vec<AgentMessagingGroup>,
}

#[async_trait::async_trait]
impl AgentGroupStore for RecordingAgentGroupStore {
    async fn upsert_agent_group(
        &self,
        _group: &AgentMessagingGroup,
    ) -> messaging_relayer::storage::StorageResult<()> {
        Ok(())
    }

    async fn list_by_principal(
        &self,
        principal: &str,
        _limit: i64,
    ) -> messaging_relayer::storage::StorageResult<Vec<AgentMessagingGroup>> {
        Ok(self
            .principal_rows
            .iter()
            .filter(|row| row.creator_principal == principal)
            .cloned()
            .collect())
    }

    async fn list_by_creator_actor(
        &self,
        creator_actor: &str,
        _limit: i64,
    ) -> messaging_relayer::storage::StorageResult<Vec<AgentMessagingGroup>> {
        Ok(self
            .principal_rows
            .iter()
            .filter(|row| row.creator_actor == creator_actor)
            .cloned()
            .collect())
    }
}

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

fn wallet_auth_headers() -> (String, String, String) {
    let timestamp = chrono::Utc::now().timestamp();
    let canonical = format!("{timestamp}:{ED25519_ADDRESS}");
    let signature = sign_bytes_ed25519(canonical.as_bytes());
    let public_key = build_public_key_with_flag(0x00, ED25519_PUBLIC_KEY);
    (timestamp.to_string(), signature, public_key)
}

fn create_test_app(agent_group_store: Arc<dyn AgentGroupStore>) -> Router {
    let config = Config::default();
    let storage = create_storage(StorageType::InMemory);
    let membership_store = Arc::new(InMemoryMembershipStore::new());
    let (sync_tx, _rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let app_state = AppState::new(
        storage,
        sync_tx,
        membership_store.clone(),
        agent_group_store,
        Arc::new(messaging_relayer::storage::NoOpWorkflowStore),
        false,
        AttributionVerifyService::from_config(&config),
        BlockCheckService::from_config(&config),
        messaging_relayer::services::MessageGateService::from_config(&config),
        messaging_relayer::services::fallback_messaging_config_cache(),
        PushService::from_config(&config),
        Arc::new(messaging_relayer::services::RealtimeHub::new()),
        true,
        true,
        30,
        900,
    );

    let auth_state = AuthState {
        membership_store,
        config,
    };

    Router::new()
        .route(
            "/v1/agent-conversations",
            get(agent_groups::list_agent_conversations),
        )
        .layer(middleware::from_fn_with_state(
            auth_state,
            wallet_auth_middleware,
        ))
        .with_state(app_state)
}

#[tokio::test]
async fn agent_conversations_requires_wallet_auth() {
    let app = create_test_app(Arc::new(NoOpAgentGroupStore));
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/agent-conversations")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn agent_conversations_returns_principal_groups_with_wallet_auth() {
    let store = Arc::new(RecordingAgentGroupStore {
        principal_rows: vec![AgentMessagingGroup {
            group_id: "0xgroup".to_string(),
            creator_actor: "0xagent".to_string(),
            creator_principal: ED25519_ADDRESS.to_string(),
            creator_sub_agent_id: None,
            creator_identity_class: None,
            organization_id: None,
            group_name: None,
            group_uuid: None,
            created_at: Utc::now(),
        }],
    });
    let app = create_test_app(store);
    let (timestamp, signature, public_key) = wallet_auth_headers();

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/agent-conversations?limit=10")
                .header("x-sender-address", ED25519_ADDRESS)
                .header("x-timestamp", timestamp)
                .header("x-signature", signature)
                .header("x-public-key", public_key)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["conversations"].as_array().unwrap().len(), 1);
    assert_eq!(json["conversations"][0]["group_id"], "0xgroup");
}
