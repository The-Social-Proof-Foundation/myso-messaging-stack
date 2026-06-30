//! Integration tests for push notification delivery using wiremock as a stand-in APNs server.

use std::sync::Arc;

use chrono::Utc;
use messaging_relayer::auth::{InMemoryMembershipStore, MembershipStore, MessagingPermission};
use messaging_relayer::models::{MessageAttribution, PushTokenRecord};
use messaging_relayer::services::push::{ApnsClient, ApnsEnvironment, PushService};
use messaging_relayer::storage::{InMemoryStorage, StorageAdapter};
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

const GROUP_ID: &str = "push-test-group";
const SENDER: &str = "0xsender";
const RECIPIENT: &str = "0xrecipient";
const DEVICE_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const BUNDLE_ID: &str = "com.example.dripdrop";

fn sample_token(environment: &str) -> PushTokenRecord {
    PushTokenRecord {
        wallet: RECIPIENT.to_string(),
        platform: "ios".to_string(),
        token: DEVICE_TOKEN.to_string(),
        environment: environment.to_string(),
        updated_at: Utc::now(),
    }
}

fn setup_membership() -> Arc<dyn MembershipStore> {
    let membership = Arc::new(InMemoryMembershipStore::new());
    membership.add_member(
        GROUP_ID,
        SENDER,
        vec![MessagingPermission::MessagingSender],
    );
    membership.add_member(
        GROUP_ID,
        RECIPIENT,
        vec![MessagingPermission::MessagingSender],
    );
    membership
}

async fn setup_push_service(mock_uri: &str) -> PushService {
    let apns = ApnsClient::from_test_http(
        mock_uri.to_string(),
        BUNDLE_ID.to_string(),
        ApnsEnvironment::Sandbox,
    );
    PushService::new_for_test(apns, 45)
}

#[tokio::test]
async fn push_sent_when_recipient_inactive() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path_regex(r"/3/device/.*"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&mock)
        .await;

    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    storage
        .upsert_push_token(sample_token("sandbox"))
        .await
        .unwrap();

    let membership = setup_membership();
    let push = setup_push_service(&mock.uri()).await;

    push
        .notify_new_message(&storage, &membership, GROUP_ID, SENDER, &MessageAttribution::human_message())
        .await;

    mock.verify().await;
}

#[tokio::test]
async fn push_skipped_when_recipient_recently_active() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path_regex(r"/3/device/.*"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&mock)
        .await;

    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    storage
        .upsert_push_token(sample_token("sandbox"))
        .await
        .unwrap();
    storage.update_presence(RECIPIENT).await.unwrap();

    let membership = setup_membership();
    let push = setup_push_service(&mock.uri()).await;

    push
        .notify_new_message(&storage, &membership, GROUP_ID, SENDER, &MessageAttribution::human_message())
        .await;

    mock.verify().await;
}

#[tokio::test]
async fn unregistered_token_is_pruned() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path_regex(r"/3/device/.*"))
        .respond_with(ResponseTemplate::new(410))
        .expect(1)
        .mount(&mock)
        .await;

    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    storage
        .upsert_push_token(sample_token("sandbox"))
        .await
        .unwrap();

    let membership = setup_membership();
    let push = setup_push_service(&mock.uri()).await;

    push
        .notify_new_message(&storage, &membership, GROUP_ID, SENDER, &MessageAttribution::human_message())
        .await;

    let remaining = storage
        .list_push_tokens_for_wallet(RECIPIENT)
        .await
        .unwrap();
    assert!(remaining.is_empty());
    mock.verify().await;
}

#[tokio::test]
async fn push_skipped_when_token_environment_mismatch() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path_regex(r"/3/device/.*"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&mock)
        .await;

    let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
    storage
        .upsert_push_token(sample_token("production"))
        .await
        .unwrap();

    let membership = setup_membership();
    let push = setup_push_service(&mock.uri()).await;

    push
        .notify_new_message(&storage, &membership, GROUP_ID, SENDER, &MessageAttribution::human_message())
        .await;

    mock.verify().await;
}
