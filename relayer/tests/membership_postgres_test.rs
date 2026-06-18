//! Integration tests for Postgres membership store.
//! Run with: DATABASE_URL=postgres://... cargo test --test membership_postgres_test -- --ignored

use messaging_relayer::auth::{
    create_membership_store_async, MembershipStore, MembershipStoreType, MessagingPermission,
};

#[tokio::test]
#[ignore = "requires DATABASE_URL pointing at a test Postgres database"]
async fn postgres_membership_loads_and_persists_permissions() {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL required");

    let store = create_membership_store_async(MembershipStoreType::Postgres, Some(&database_url))
        .await;

    let group_id = "test-group-pg-membership";
    let address = "0xabc1234567890abc1234567890abc1234567890abc1234567890abc1234567890";

    store.add_member(group_id, address, vec![]);
    store
        .grant_permissions(group_id, address, vec![MessagingPermission::MessagingSender])
        .expect("grant should succeed");

    assert!(store.has_permission(
        group_id,
        address,
        MessagingPermission::MessagingSender
    ));

    // Simulate restart: new store instance loads from Postgres
    let store2 = create_membership_store_async(MembershipStoreType::Postgres, Some(&database_url))
        .await;

    assert!(store2.has_permission(
        group_id,
        address,
        MessagingPermission::MessagingSender
    ));

    store2.set_last_checkpoint_cursor(42_000);
    assert_eq!(store2.get_last_checkpoint_cursor(), Some(42_000));

    let store3 = create_membership_store_async(MembershipStoreType::Postgres, Some(&database_url))
        .await;
    assert_eq!(store3.get_last_checkpoint_cursor(), Some(42_000));

    store3.remove_member(group_id, address);
    assert!(!store3.is_member(group_id, address));
}
