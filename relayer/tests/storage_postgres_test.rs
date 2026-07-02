//! Integration tests for Postgres storage (reactions, pins, nonce dedup,
//! group activity, read-state CAS).
//! Run with: DATABASE_URL=postgres://... cargo test --test storage_postgres_test -- --ignored

use chrono::Utc;
use messaging_relayer::models::{Message, MessageAttribution, PaidEscrowRecord, SyncStatus};
use messaging_relayer::storage::{
    create_postgres_storage, PutUserReadStateResult, StorageAdapter, StorageError,
};
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

#[tokio::test]
#[ignore = "requires DATABASE_URL pointing at a test Postgres database"]
async fn postgres_paid_escrow_upsert_and_gate_lookups() {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL required");
    let group_id = format!("test-group-pg-escrow-{}", Uuid::new_v4());
    let payer = "0xpayer";
    let recipient = "0xrecipient";

    let storage = create_postgres_storage(&database_url).await.unwrap();

    let record = PaidEscrowRecord {
        group_id: group_id.clone(),
        seq: 0,
        payer: payer.to_string(),
        recipient: recipient.to_string(),
        amount: 100,
        created_at_ms: 1_700_000_000_000,
    };
    storage.record_paid_escrow(record.clone()).await.unwrap();
    // Checkpoint replay: same (group_id, seq) upserts instead of erroring.
    storage.record_paid_escrow(record).await.unwrap();

    assert!(storage
        .has_paid_escrow(&group_id, payer, recipient, 0)
        .await
        .unwrap());
    assert!(storage
        .has_paid_escrow(&group_id, payer, recipient, 100)
        .await
        .unwrap());
    // min_amount above the escrowed value does not match.
    assert!(!storage
        .has_paid_escrow(&group_id, payer, recipient, 101)
        .await
        .unwrap());
    // Direction matters: recipient never paid the payer.
    assert!(!storage
        .has_paid_escrow(&group_id, recipient, payer, 0)
        .await
        .unwrap());

    // Latest-amount lookup: highest-seq escrow wins, direction still matters.
    assert_eq!(
        storage
            .latest_paid_escrow_amount(&group_id, payer, recipient)
            .await
            .unwrap(),
        Some(100)
    );
    storage
        .record_paid_escrow(PaidEscrowRecord {
            group_id: group_id.clone(),
            seq: 1,
            payer: payer.to_string(),
            recipient: recipient.to_string(),
            amount: 250,
            created_at_ms: 1_700_000_000_001,
        })
        .await
        .unwrap();
    assert_eq!(
        storage
            .latest_paid_escrow_amount(&group_id, payer, recipient)
            .await
            .unwrap(),
        Some(250)
    );
    assert_eq!(
        storage
            .latest_paid_escrow_amount(&group_id, recipient, payer)
            .await
            .unwrap(),
        None
    );

    // First-outbound-message lookups are per-sender.
    let mut nonce = b"escrow-nonce-01".to_vec();
    nonce[0] = rand::random::<u8>();
    storage
        .create_message(sample_message(&group_id, nonce))
        .await
        .unwrap();
    assert!(storage
        .has_message_from(&group_id, "0xsender")
        .await
        .unwrap());
    assert!(!storage
        .has_message_from(&group_id, recipient)
        .await
        .unwrap());
}

#[tokio::test]
#[ignore = "requires DATABASE_URL pointing at a test Postgres database"]
async fn postgres_group_activity_counts_exclude_deleted() {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL required");
    let group_id = format!("test-group-pg-activity-{}", Uuid::new_v4());

    let storage = create_postgres_storage(&database_url).await.unwrap();

    let mut ids = Vec::new();
    for i in 0..3u8 {
        let mut nonce = vec![0u8; 15];
        nonce[0] = i;
        nonce[1] = rand::random::<u8>();
        nonce[2] = rand::random::<u8>();
        let created = storage
            .create_message(sample_message(&group_id, nonce))
            .await
            .unwrap();
        ids.push(created.id);
    }

    let all = storage.get_group_activity(&group_id, 0).await.unwrap();
    assert_eq!(all.latest_order, 3);
    assert_eq!(all.unread_count, 3);

    // after_order is exclusive.
    let after = storage.get_group_activity(&group_id, 2).await.unwrap();
    assert_eq!(after.unread_count, 1);

    // Soft-deleted rows keep their order slot but never count as unread.
    storage.delete_message(ids[2]).await.unwrap();
    let after_delete = storage.get_group_activity(&group_id, 0).await.unwrap();
    assert_eq!(after_delete.latest_order, 3);
    assert_eq!(after_delete.unread_count, 2);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL pointing at a test Postgres database"]
async fn postgres_read_state_cas_versions_and_conflicts() {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL required");
    let wallet = format!("0xtest-read-state-{}", Uuid::new_v4());

    let storage = create_postgres_storage(&database_url).await.unwrap();

    // First write: server assigns version 1.
    let first = storage
        .put_user_read_state(&wallet, vec![1], None)
        .await
        .unwrap();
    assert!(matches!(
        first,
        PutUserReadStateResult::Stored { blob_version: 1 }
    ));

    // CAS success bumps to 2.
    let cas_ok = storage
        .put_user_read_state(&wallet, vec![2], Some(1))
        .await
        .unwrap();
    assert!(matches!(
        cas_ok,
        PutUserReadStateResult::Stored { blob_version: 2 }
    ));

    // Stale expectation conflicts and returns the current record unchanged.
    let conflict = storage
        .put_user_read_state(&wallet, vec![9], Some(1))
        .await
        .unwrap();
    let PutUserReadStateResult::Conflict { current } = conflict else {
        panic!("expected conflict");
    };
    assert_eq!(current.blob_version, 2);
    assert_eq!(current.encrypted_blob, vec![2]);

    // Survives reconnect with the CAS-protected value.
    let storage2 = create_postgres_storage(&database_url).await.unwrap();
    let stored = storage2.get_user_read_state(&wallet).await.unwrap().unwrap();
    assert_eq!(stored.blob_version, 2);
    assert_eq!(stored.encrypted_blob, vec![2]);
}
