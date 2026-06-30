#[test_only]
module messaging::group_handle_registry_tests;

use messaging::group_handle_registry::{Self, GroupHandleRegistry};
use messaging::group_manager::GroupManager;
use messaging::messaging::{
    Self as msg,
    Messaging,
    MessagingNamespace,
    MessagingReader,
};
use messaging::version::{Self, Version};
use social_contracts::block_list::BlockListRegistry;
use myso::permissioned_group::PermissionedGroup;
use myso::test_scenario as ts;
use myso::vec_set;
use std::string;
use std::unit_test::{assert_eq, destroy};

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;

const TEST_ENCRYPTED_DEK: vector<u8> = b"test_encrypted_dek";
const TEST_UUID: vector<u8> = b"550e8400-e29b-41d4-a716-446655440200";
const TEST_UUID_2: vector<u8> = b"550e8400-e29b-41d4-a716-446655440201";
const TEST_GROUP_NAME: vector<u8> = b"Test Group";

#[test, expected_failure(abort_code = msg::ENotPermitted)]
fun set_group_handle_without_permission_fails() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    msg::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let version = ts.take_shared<Version>();
    let group_manager = ts.take_shared<GroupManager>();
    let block_list = ts.take_shared<BlockListRegistry>();
    let (mut group, encryption_history, msg_log) = msg::create_group_unchecked(
        &version,
        &mut namespace,
        &group_manager,
        &block_list,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );
    group.grant_permission<Messaging, MessagingReader>(BOB, ts.ctx());
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    destroy(msg_log);
    ts::return_shared(version);
    ts::return_shared(group_manager);
    ts::return_shared(block_list);
    ts::return_shared(namespace);

    ts.next_tx(BOB);
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    let version = ts.take_shared<Version>();
    let mut registry = ts.take_shared<GroupHandleRegistry>();

    msg::set_group_handle(
        &version,
        &mut registry,
        &mut group,
        string::utf8(b"bobhandle"),
        ts.ctx(),
    );

    abort
}

#[test]
fun set_group_handle_and_lookup_succeeds() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    msg::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let version = ts.take_shared<Version>();
    let group_manager = ts.take_shared<GroupManager>();
    let block_list = ts.take_shared<BlockListRegistry>();
    let (group, encryption_history, msg_log) = msg::create_group_unchecked(
        &version,
        &mut namespace,
        &group_manager,
        &block_list,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID_2),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );
    let gid = object::id(&group);
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    destroy(msg_log);
    ts::return_shared(version);
    ts::return_shared(group_manager);
    ts::return_shared(block_list);
    ts::return_shared(namespace);

    ts.next_tx(ALICE);
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    let version = ts.take_shared<Version>();
    let mut registry = ts.take_shared<GroupHandleRegistry>();

    msg::set_group_handle(
        &version,
        &mut registry,
        &mut group,
        string::utf8(b"AliceTeam"),
        ts.ctx(),
    );

    let found = msg::lookup_group_by_handle(&registry, string::utf8(b"aliceteam"));
    assert!(option::is_some(&found), 0);
    assert_eq!(option::destroy_some(found), gid);

    ts::return_shared(group);
    ts::return_shared(version);
    ts::return_shared(registry);
    ts.end();
}

#[test, expected_failure(abort_code = group_handle_registry::EHandleTaken)]
fun duplicate_group_handle_fails() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    msg::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let version = ts.take_shared<Version>();
    let group_manager = ts.take_shared<GroupManager>();
    let block_list = ts.take_shared<BlockListRegistry>();

    let (g1, eh1, ml1) = msg::create_group_unchecked(
        &version,
        &mut namespace,
        &group_manager,
        &block_list,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );
    let (g2, eh2, ml2) = msg::create_group_unchecked(
        &version,
        &mut namespace,
        &group_manager,
        &block_list,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID_2),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );

    transfer::public_share_object(g1);
    transfer::public_share_object(eh1);
    destroy(ml1);
    transfer::public_share_object(g2);
    transfer::public_share_object(eh2);
    destroy(ml2);
    ts::return_shared(version);
    ts::return_shared(group_manager);
    ts::return_shared(block_list);
    ts::return_shared(namespace);

    ts.next_tx(ALICE);
    let mut g1 = ts.take_shared<PermissionedGroup<Messaging>>();
    let mut g2 = ts.take_shared<PermissionedGroup<Messaging>>();
    let version = ts.take_shared<Version>();
    let mut registry = ts.take_shared<GroupHandleRegistry>();

    let h = string::utf8(b"sharedname");
    msg::set_group_handle(&version, &mut registry, &mut g1, h, ts.ctx());
    msg::set_group_handle(
        &version,
        &mut registry,
        &mut g2,
        string::utf8(b"sharedname"),
        ts.ctx(),
    );

    abort
}
