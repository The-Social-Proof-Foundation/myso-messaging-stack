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
    let first = storage
        .set_reaction(group_id, 1, "😀", "0xalice", true)
        .await
        .unwrap();
    assert!(first.is_some());

    // Idempotent re-add: no change.
    let dup = storage
        .set_reaction(group_id, 1, "😀", "0xalice", true)
        .await
        .unwrap();
    assert!(dup.is_none());

    let second = storage
        .set_reaction(group_id, 1, "😀", "0xbob", true)
        .await
        .unwrap()
        .expect("second reactor changes state");
    assert_eq!(second.count, 2);
    assert_eq!(second.reactors, vec!["0xalice", "0xbob"]);

    // Multi-code-point emoji (ZWJ sequence) round-trips through TEXT storage.
    let family = storage
        .set_reaction(group_id, 1, "👨‍👩‍👧‍👦", "0xalice", true)
        .await
        .unwrap()
        .expect("zwj emoji add changes state");
    assert_eq!(family.emoji, "👨‍👩‍👧‍👦");

    storage.set_pin_for_seq(group_id, 5, true).await.unwrap();

    let storage2 = create_postgres_storage(&database_url).await.unwrap();
    let reactions = storage2.list_reactions(group_id, None).await.unwrap();
    assert_eq!(reactions.len(), 2);
    let smiley = reactions.iter().find(|r| r.emoji == "😀").unwrap();
    assert_eq!(smiley.count, 2);
    assert_eq!(smiley.reactors, vec!["0xalice", "0xbob"]);

    // Removal is per-user and idempotent.
    let removed = storage2
        .set_reaction(group_id, 1, "😀", "0xalice", false)
        .await
        .unwrap()
        .expect("removal changes state");
    assert_eq!(removed.count, 1);
    assert_eq!(removed.reactors, vec!["0xbob"]);
    let absent = storage2
        .set_reaction(group_id, 1, "😀", "0xalice", false)
        .await
        .unwrap();
    assert!(absent.is_none());

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
