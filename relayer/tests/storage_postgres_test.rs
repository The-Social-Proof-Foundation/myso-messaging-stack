//! Integration tests for Postgres storage (reactions, pins, nonce dedup).
//! Run with: DATABASE_URL=postgres://... cargo test --test storage_postgres_test -- --ignored

use chrono::Utc;
use messaging_relayer::models::{Message, MessageAttribution, SyncStatus};
use messaging_relayer::storage::{create_postgres_storage, StorageAdapter, StorageError};
use uuid::Uuid;

fn sample_message(group_id: &str, nonce: Vec<u8>) -> Message {
    Message {
        id: Uuid::new_v4(),
        group_id: group_id.to_string(),
        order: None,
        sender_wallet_addr: "0xsender".to_string(),
        encrypted_msg: b"cipher".to_vec(),
        nonce,
        key_version: 0,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        sync_status: SyncStatus::SyncPending,
        quilt_patch_id: None,
        attachments: vec![],
        signature: vec![1; 64],
        public_key: vec![0; 33],
        attribution: MessageAttribution::human_message(),
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL pointing at a test Postgres database"]
async fn postgres_reactions_and_pins_survive_reconnect() {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL required");
    let group_id = "test-group-pg-storage";

    let storage = create_postgres_storage(&database_url).await.unwrap();
    storage
        .replace_reaction_tally(group_id, 1, 0x1f600, true)
        .await
        .unwrap();
    storage.set_pin_for_seq(group_id, 5, true).await.unwrap();

    let storage2 = create_postgres_storage(&database_url).await.unwrap();
    let reactions = storage2.list_reactions(group_id, None).await.unwrap();
    assert_eq!(reactions.len(), 1);
    assert_eq!(reactions[0].count, 1);

    let pins = storage2.list_pins(group_id).await.unwrap();
    assert_eq!(pins, vec![5]);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL pointing at a test Postgres database"]
async fn postgres_rejects_duplicate_nonce() {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL required");
    let group_id = "test-group-pg-nonce";
    let nonce = b"unique-nonce-12".to_vec();

    let storage = create_postgres_storage(&database_url).await.unwrap();
    storage
        .create_message(sample_message(group_id, nonce.clone()))
        .await
        .unwrap();

    let err = storage
        .create_message(sample_message(group_id, nonce))
        .await
        .unwrap_err();
    assert!(matches!(err, StorageError::DuplicateNonce));
}
