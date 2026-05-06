#[test_only]
module example_app::custom_mydata_policy_tests;

use myso_groups::permissioned_group::PermissionedGroup;
use myso_messaging_stack::messaging::{Self, Messaging, MessagingNamespace};
use myso_messaging_stack::encryption_history::EncryptionHistory;
use myso_messaging_stack::group_manager::GroupManager;
use myso_messaging_stack::version::{Self, Version};
use myso::vec_set;
use example_app::custom_mydata_policy;
use myso::clock;
use myso::coin;
use myso::myso::MYSO;
use myso::test_scenario::{Self as ts, Scenario};
use myso::bcs;
use std::string;
use std::unit_test::destroy;

const ALICE: address = @0xA11CE;
const SERVICE_FEE: u64 = 10;
const SERVICE_TTL: u64 = 1000;

const TEST_UUID: vector<u8> = b"550e8400-e29b-41d4-a716-446655440000";
const TEST_UUID_2: vector<u8> = b"550e8400-e29b-41d4-a716-446655440001";
const TEST_UUID_3: vector<u8> = b"550e8400-e29b-41d4-a716-446655440002";

/// Builds standard identity bytes: [group_id (32 bytes)][key_version (8 bytes LE u64)]
fun build_identity_bytes(group_id: ID, key_version: u64): vector<u8> {
    let mut bytes = group_id.to_bytes();
    bytes.append(bcs::to_bytes(&key_version));
    bytes
}

/// Sets up a messaging group and returns (group_id, encryption_history_id).
/// Uses the real create_group flow with MessagingNamespace and EncryptionHistory.
fun setup_group(ts: &mut Scenario): (ID, ID) {
    // Initialize the messaging module (creates MessagingNamespace)
    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    // Alice creates group using the real flow
    ts.next_tx(ALICE);
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let version = ts.take_shared<Version>();
    let group_manager = ts.take_shared<GroupManager>();
    let (group, encryption_history) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(b"Test Group"),
        string::utf8(TEST_UUID),
        b"test_encrypted_dek",
        vec_set::empty(),
        ts.ctx(),
    );
    let group_id = object::id(&group);
    let encryption_history_id = object::id(&encryption_history);
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(group_manager);
    ts::return_shared(namespace);

    (group_id, encryption_history_id)
}

#[test]
fun mydata_approve_valid_subscription() {
    let mut ts = ts::begin(ALICE);
    let (group_id, enc_history_id) = setup_group(&mut ts);

    // Create service and subscribe
    ts.next_tx(ALICE);
    let clock = clock::create_for_testing(ts.ctx());
    let service = custom_mydata_policy::create_service<MYSO>(group_id, SERVICE_FEE, SERVICE_TTL, ts.ctx());
    let payment = coin::mint_for_testing<MYSO>(SERVICE_FEE, ts.ctx());
    let sub = custom_mydata_policy::subscribe(&service, payment, &clock, ts.ctx());

    // Build standard identity bytes [groupId][keyVersion=0]
    let test_id = build_identity_bytes(group_id, 0);

    // Get group and encryption history for mydata_approve
    let group = ts.take_shared_by_id<PermissionedGroup<Messaging>>(group_id);
    let encryption_history = ts.take_shared_by_id<EncryptionHistory>(enc_history_id);

    // Should pass at time 0
    custom_mydata_policy::mydata_approve(test_id, &sub, &service, &group, &encryption_history, &clock, ts.ctx());

    // Cleanup
    ts::return_shared(group);
    ts::return_shared(encryption_history);
    destroy(service);
    destroy(sub);
    destroy(clock);
    ts.end();
}

#[test]
fun mydata_approve_within_ttl() {
    let mut ts = ts::begin(ALICE);
    let (group_id, enc_history_id) = setup_group(&mut ts);

    ts.next_tx(ALICE);
    let mut clock = clock::create_for_testing(ts.ctx());
    let service = custom_mydata_policy::create_service<MYSO>(group_id, SERVICE_FEE, SERVICE_TTL, ts.ctx());
    let payment = coin::mint_for_testing<MYSO>(SERVICE_FEE, ts.ctx());
    let sub = custom_mydata_policy::subscribe(&service, payment, &clock, ts.ctx());

    let test_id = build_identity_bytes(group_id, 0);

    let group = ts.take_shared_by_id<PermissionedGroup<Messaging>>(group_id);
    let encryption_history = ts.take_shared_by_id<EncryptionHistory>(enc_history_id);

    // Should pass at time 500 (within TTL)
    clock.increment_for_testing(500);
    custom_mydata_policy::mydata_approve(test_id, &sub, &service, &group, &encryption_history, &clock, ts.ctx());

    ts::return_shared(group);
    ts::return_shared(encryption_history);
    destroy(service);
    destroy(sub);
    destroy(clock);
    ts.end();
}

#[test]
fun mydata_approve_at_ttl_boundary() {
    let mut ts = ts::begin(ALICE);
    let (group_id, enc_history_id) = setup_group(&mut ts);

    ts.next_tx(ALICE);
    let mut clock = clock::create_for_testing(ts.ctx());
    let service = custom_mydata_policy::create_service<MYSO>(group_id, SERVICE_FEE, SERVICE_TTL, ts.ctx());
    let payment = coin::mint_for_testing<MYSO>(SERVICE_FEE, ts.ctx());
    let sub = custom_mydata_policy::subscribe(&service, payment, &clock, ts.ctx());

    let test_id = build_identity_bytes(group_id, 0);

    let group = ts.take_shared_by_id<PermissionedGroup<Messaging>>(group_id);
    let encryption_history = ts.take_shared_by_id<EncryptionHistory>(enc_history_id);

    // Should pass at time 1000 (exactly at TTL boundary)
    clock.increment_for_testing(1000);
    custom_mydata_policy::mydata_approve(test_id, &sub, &service, &group, &encryption_history, &clock, ts.ctx());

    ts::return_shared(group);
    ts::return_shared(encryption_history);
    destroy(service);
    destroy(sub);
    destroy(clock);
    ts.end();
}

#[test, expected_failure(abort_code = custom_mydata_policy::ENoAccess)]
fun mydata_approve_expired_subscription() {
    let mut ts = ts::begin(ALICE);
    let (group_id, enc_history_id) = setup_group(&mut ts);

    ts.next_tx(ALICE);
    let mut clock = clock::create_for_testing(ts.ctx());
    let service = custom_mydata_policy::create_service<MYSO>(group_id, SERVICE_FEE, SERVICE_TTL, ts.ctx());
    let payment = coin::mint_for_testing<MYSO>(SERVICE_FEE, ts.ctx());
    let sub = custom_mydata_policy::subscribe(&service, payment, &clock, ts.ctx());

    let test_id = build_identity_bytes(group_id, 0);

    let group = ts.take_shared_by_id<PermissionedGroup<Messaging>>(group_id);
    let encryption_history = ts.take_shared_by_id<EncryptionHistory>(enc_history_id);

    // Should fail at time 1001 (expired)
    clock.increment_for_testing(1001);
    custom_mydata_policy::mydata_approve(test_id, &sub, &service, &group, &encryption_history, &clock, ts.ctx());

    abort // will differ from ENoAccess
}

#[test, expected_failure(abort_code = custom_mydata_policy::ENoAccess)]
fun mydata_approve_wrong_group() {
    let mut ts = ts::begin(ALICE);

    // Initialize messaging
    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    // Create two groups
    ts.next_tx(ALICE);
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let version = ts.take_shared<Version>();
    let group_manager = ts.take_shared<GroupManager>();
    let (group1, encryption_history1) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(b"Group 1"),
        string::utf8(TEST_UUID_2),
        b"test_encrypted_dek_1",
        vec_set::empty(),
        ts.ctx(),
    );
    let group1_id = object::id(&group1);
    transfer::public_share_object(group1);
    transfer::public_share_object(encryption_history1);

    let (group2, encryption_history2) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(b"Group 2"),
        string::utf8(TEST_UUID_3),
        b"test_encrypted_dek_2",
        vec_set::empty(),
        ts.ctx(),
    );
    let group2_id = object::id(&group2);
    let enc_history2_id = object::id(&encryption_history2);
    transfer::public_share_object(group2);
    transfer::public_share_object(encryption_history2);
    ts::return_shared(version);
    ts::return_shared(group_manager);
    ts::return_shared(namespace);

    // Service is linked to group1
    ts.next_tx(ALICE);
    let clock = clock::create_for_testing(ts.ctx());
    let service = custom_mydata_policy::create_service<MYSO>(group1_id, SERVICE_FEE, SERVICE_TTL, ts.ctx());
    let payment = coin::mint_for_testing<MYSO>(SERVICE_FEE, ts.ctx());
    let sub = custom_mydata_policy::subscribe(&service, payment, &clock, ts.ctx());

    // Build identity bytes with group2_id so validate_identity passes for group2,
    // but service.group_id == group1_id → check_policy catches the mismatch.
    let test_id = build_identity_bytes(group2_id, 0);

    // Pass group2 + its encryption_history (validate_identity passes),
    // but service is linked to group1 → check_policy fails with ENoAccess.
    ts.next_tx(ALICE);
    let group2 = ts.take_shared_by_id<PermissionedGroup<Messaging>>(group2_id);
    let enc_history2 = ts.take_shared_by_id<EncryptionHistory>(enc_history2_id);

    custom_mydata_policy::mydata_approve(test_id, &sub, &service, &group2, &enc_history2, &clock, ts.ctx());

    abort // will differ from ENoAccess
}