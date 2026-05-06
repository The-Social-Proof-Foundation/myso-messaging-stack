#[test_only]
module myso_messaging_stack::mysons_manager_tests;

use myso_messaging_stack::group_manager::GroupManager;
use myso_messaging_stack::messaging::{Self, Messaging, MessagingNamespace, MessagingReader};
use myso_messaging_stack::version::{Self, Version};
use myso_groups::permissioned_group::PermissionedGroup;
use myso::test_scenario as ts;
use myso::vec_set;
use mysons::mysons::{Self, MySoNS};

// === Test Addresses ===

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;

// === Test Data ===

const TEST_ENCRYPTED_DEK: vector<u8> = b"test_encrypted_dek";
const TEST_UUID: vector<u8> = b"550e8400-e29b-41d4-a716-446655440100";
const TEST_UUID_2: vector<u8> = b"550e8400-e29b-41d4-a716-446655440101";
const TEST_DOMAIN: vector<u8> = b"mygroup.myso";
const TEST_GROUP_NAME: vector<u8> = b"Test Group";

// === Helper Functions ===

/// Creates a minimal MySoNS object for testing.
/// The MySoNS doesn't need full setup (registry, ControllerV2 auth) because
/// the permission check aborts before any MySoNS interaction.
fun setup_mysons(ctx: &mut TxContext): MySoNS {
    let (mysons, admin_cap) = mysons::new_for_testing(ctx);
    transfer::public_transfer(admin_cap, ctx.sender());
    mysons
}

// === set_mysons_reverse_lookup tests ===

#[test, expected_failure(abort_code = myso_messaging_stack::messaging::ENotPermitted)]
fun set_mysons_reverse_lookup_without_permission_fails() {
    let mut ts = ts::begin(ALICE);

    // Initialize messaging namespace
    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    // Create a group — Alice is creator with all permissions
    ts.next_tx(ALICE);
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let version = ts.take_shared<Version>();
    let group_manager = ts.take_shared<GroupManager>();
    let (mut group, encryption_history) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        TEST_GROUP_NAME.to_string(),
        TEST_UUID.to_string(),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );
    // Grant Bob only MessagingReader (no MySoNsAdmin)
    group.grant_permission<Messaging, MessagingReader>(BOB, ts.ctx());
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(group_manager);
    ts::return_shared(namespace);

    // Set up MySoNS (minimal — permission check aborts before MySoNS is touched)
    ts.next_tx(BOB);
    let mysons = setup_mysons(ts.ctx());
    mysons.share_for_testing();

    // Bob tries to set reverse lookup — should fail with ENotPermitted
    ts.next_tx(BOB);
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    let group_manager = ts.take_shared<GroupManager>();
    let mut mysons = ts.take_shared<MySoNS>();

    messaging::set_mysons_reverse_lookup(
        &group_manager,
        &mut group,
        &mut mysons,
        TEST_DOMAIN.to_string(),
        ts.ctx(),
    );

    abort
}

// === unset_mysons_reverse_lookup tests ===

#[test, expected_failure(abort_code = myso_messaging_stack::messaging::ENotPermitted)]
fun unset_mysons_reverse_lookup_without_permission_fails() {
    let mut ts = ts::begin(ALICE);

    // Initialize messaging namespace
    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    // Create a group
    ts.next_tx(ALICE);
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let version = ts.take_shared<Version>();
    let group_manager = ts.take_shared<GroupManager>();
    let (mut group, encryption_history) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        TEST_GROUP_NAME.to_string(),
        TEST_UUID_2.to_string(),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );
    // Grant Bob only MessagingReader
    group.grant_permission<Messaging, MessagingReader>(BOB, ts.ctx());
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(group_manager);
    ts::return_shared(namespace);

    // Set up MySoNS (minimal)
    ts.next_tx(BOB);
    let mysons = setup_mysons(ts.ctx());
    mysons.share_for_testing();

    // Bob tries to unset reverse lookup — should fail with ENotPermitted
    ts.next_tx(BOB);
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    let group_manager = ts.take_shared<GroupManager>();
    let mut mysons = ts.take_shared<MySoNS>();

    messaging::unset_mysons_reverse_lookup(
        &group_manager,
        &mut group,
        &mut mysons,
        ts.ctx(),
    );

    abort
}
