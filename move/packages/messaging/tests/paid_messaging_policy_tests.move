#[test_only]
module messaging::paid_messaging_policy_tests;

use messaging::group_manager::GroupManager;
use messaging::message_log::MessageLog;
use messaging::messaging::{
    Self as msg,
    Messaging,
    MessagingNamespace,
};
use messaging::paid_messaging_policy::{Self, PaidMessagingRegistry};
use messaging::version::{Self, Version};
use myso::clock;
use myso::coin;
use myso::myso::MYSO;
use myso::permissioned_group::PermissionedGroup;
use myso::test_scenario as ts;
use myso::vec_set;
use social_contracts::block_list::{Self, BlockListRegistry};
use social_contracts::social_graph::{Self, SocialGraph};
use std::option;
use std::string;
use std::unit_test::{assert_eq, destroy};

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const TEST_UUID: vector<u8> = b"550e8400-e29b-41d4-a716-446655440000";
const TEST_UUID_2: vector<u8> = b"550e8400-e29b-41d4-a716-446655440001";
const TEST_UUID_3: vector<u8> = b"550e8400-e29b-41d4-a716-446655440002";
const TEST_UUID_4: vector<u8> = b"550e8400-e29b-41d4-a716-446655440003";
const TEST_UUID_5: vector<u8> = b"550e8400-e29b-41d4-a716-446655440004";
const TEST_UUID_6: vector<u8> = b"550e8400-e29b-41d4-a716-446655440005";
const TEST_UUID_7: vector<u8> = b"550e8400-e29b-41d4-a716-446655440006";
const TEST_UUID_8: vector<u8> = b"550e8400-e29b-41d4-a716-446655440007";
const TEST_UUID_9: vector<u8> = b"550e8400-e29b-41d4-a716-446655440008";

fun setup_dm(
    scenario: &mut ts::Scenario,
    creator: address,
    peer: address,
    uuid: vector<u8>,
): (ID, ID) {
    ts::next_tx(scenario, creator);
    let version = ts::take_shared<Version>(scenario);
    let mut namespace = ts::take_shared<MessagingNamespace>(scenario);
    let group_manager = ts::take_shared<GroupManager>(scenario);
    let block_list = ts::take_shared<BlockListRegistry>(scenario);
    let mut members = vec_set::empty();
    members.insert(peer);
    let (group, encryption_history, msg_log) = msg::create_group(
        &version,
        &mut namespace,
        &group_manager,
        &block_list,
        string::utf8(b"dm"),
        string::utf8(uuid),
        b"dek",
        members,
        ts::ctx(scenario),
    );
    let gid = object::id(&group);
    let msg_log_id = object::id(&msg_log);
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    transfer::public_share_object(msg_log);
    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);
    ts::return_shared(block_list);
    (gid, msg_log_id)
}

#[test]
fun create_dm_tags_conversation_kind() {
    let mut scenario = ts::begin(ALICE);
    msg::init_for_testing(ts::ctx(&mut scenario));
    version::init_for_testing(ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, ALICE);
    let version = ts::take_shared<Version>(&mut scenario);
    let mut namespace = ts::take_shared<MessagingNamespace>(&mut scenario);
    let group_manager = ts::take_shared<GroupManager>(&mut scenario);
    let block_list = ts::take_shared<BlockListRegistry>(&mut scenario);
    let mut members = vec_set::empty();
    members.insert(BOB);
    let (group, encryption_history, msg_log) = msg::create_group(
        &version,
        &mut namespace,
        &group_manager,
        &block_list,
        string::utf8(b"dm"),
        string::utf8(TEST_UUID),
        b"dek",
        members,
        ts::ctx(&mut scenario),
    );
    assert!(msg::is_dm_group_for_testing(&group_manager, &group));
    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);
    ts::return_shared(block_list);
    destroy(group);
    destroy(encryption_history);
    destroy(msg_log);
    ts::end(scenario);
}

#[test]
fun set_policy_and_requires_payment_from() {
    let mut scenario = ts::begin(ALICE);
    msg::init_for_testing(ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, ALICE);
    let mut registry = ts::take_shared<PaidMessagingRegistry>(&mut scenario);
    paid_messaging_policy::set_paid_messaging_policy(
        &mut registry,
        true,
        option::some(500),
        ts::ctx(&mut scenario),
    );
    assert_eq!(paid_messaging_policy::requires_payment_from(&registry, ALICE), option::some(500));
    ts::return_shared(registry);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = msg::EBelowMinMessageCost)]
fun stranger_dm_below_min_fails() {
    let mut scenario = ts::begin(ALICE);
    msg::init_for_testing(ts::ctx(&mut scenario));
    version::init_for_testing(ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, ALICE);
    let mut paid_registry = ts::take_shared<PaidMessagingRegistry>(&mut scenario);
    paid_messaging_policy::set_paid_messaging_policy(
        &mut paid_registry,
        true,
        option::some(1000),
        ts::ctx(&mut scenario),
    );
    ts::return_shared(paid_registry);

    let (gid, msg_log_id) = setup_dm(&mut scenario, BOB, ALICE, TEST_UUID_2);

    ts::next_tx(&mut scenario, BOB);
    let version = ts::take_shared<Version>(&mut scenario);
    let group = ts::take_shared_by_id<PermissionedGroup<Messaging>>(&mut scenario, gid);
    let mut msg_log = ts::take_shared_by_id<MessageLog>(&mut scenario, msg_log_id);
    let paid_registry = ts::take_shared<PaidMessagingRegistry>(&mut scenario);
    let social_graph = ts::take_shared<SocialGraph>(&mut scenario);
    let group_manager = ts::take_shared<GroupManager>(&mut scenario);
    let block_list = ts::take_shared<BlockListRegistry>(&mut scenario);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    let payment = coin::mint_for_testing<MYSO>(500, ts::ctx(&mut scenario));
    msg::send_paid_message_digest(
        &version,
        &group,
        &mut msg_log,
        &paid_registry,
        &social_graph,
        &block_list,
        &group_manager,
        ALICE,
        payment,
        500,
        b"dedupe",
        1u128,
        &clock,
        ts::ctx(&mut scenario),
    );
    abort
}

#[test]
fun stranger_dm_at_min_succeeds() {
    let mut scenario = ts::begin(ALICE);
    msg::init_for_testing(ts::ctx(&mut scenario));
    version::init_for_testing(ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, ALICE);
    let mut paid_registry = ts::take_shared<PaidMessagingRegistry>(&mut scenario);
    paid_messaging_policy::set_paid_messaging_policy(
        &mut paid_registry,
        true,
        option::some(1000),
        ts::ctx(&mut scenario),
    );
    ts::return_shared(paid_registry);

    let (gid, msg_log_id) = setup_dm(&mut scenario, BOB, ALICE, TEST_UUID_3);

    ts::next_tx(&mut scenario, BOB);
    let version = ts::take_shared<Version>(&mut scenario);
    let group = ts::take_shared_by_id<PermissionedGroup<Messaging>>(&mut scenario, gid);
    let mut msg_log = ts::take_shared_by_id<MessageLog>(&mut scenario, msg_log_id);
    let paid_registry = ts::take_shared<PaidMessagingRegistry>(&mut scenario);
    let social_graph = ts::take_shared<SocialGraph>(&mut scenario);
    let group_manager = ts::take_shared<GroupManager>(&mut scenario);
    let block_list = ts::take_shared<BlockListRegistry>(&mut scenario);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    let payment = coin::mint_for_testing<MYSO>(1000, ts::ctx(&mut scenario));
    msg::send_paid_message_digest(
        &version,
        &group,
        &mut msg_log,
        &paid_registry,
        &social_graph,
        &block_list,
        &group_manager,
        ALICE,
        payment,
        1000,
        b"dedupe",
        1u128,
        &clock,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(version);
    ts::return_shared(group);
    ts::return_shared(msg_log);
    ts::return_shared(paid_registry);
    ts::return_shared(social_graph);
    ts::return_shared(group_manager);
    ts::return_shared(block_list);
    destroy(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = msg::EPaidNotRequiredForFollower)]
fun follower_paid_open_on_new_dm_fails() {
    let mut scenario = ts::begin(ALICE);
    msg::init_for_testing(ts::ctx(&mut scenario));
    version::init_for_testing(ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, ALICE);
    let mut paid_registry = ts::take_shared<PaidMessagingRegistry>(&mut scenario);
    paid_messaging_policy::set_paid_messaging_policy(
        &mut paid_registry,
        true,
        option::some(1000),
        ts::ctx(&mut scenario),
    );
    ts::return_shared(paid_registry);

    ts::next_tx(&mut scenario, BOB);
    let mut social_graph = ts::take_shared<SocialGraph>(&mut scenario);
    social_graph::follow(&mut social_graph, ALICE, ts::ctx(&mut scenario));
    ts::return_shared(social_graph);

    let (gid, msg_log_id) = setup_dm(&mut scenario, BOB, ALICE, TEST_UUID_4);

    ts::next_tx(&mut scenario, BOB);
    let version = ts::take_shared<Version>(&mut scenario);
    let group = ts::take_shared_by_id<PermissionedGroup<Messaging>>(&mut scenario, gid);
    let mut msg_log = ts::take_shared_by_id<MessageLog>(&mut scenario, msg_log_id);
    let paid_registry = ts::take_shared<PaidMessagingRegistry>(&mut scenario);
    let social_graph = ts::take_shared<SocialGraph>(&mut scenario);
    let group_manager = ts::take_shared<GroupManager>(&mut scenario);
    let block_list = ts::take_shared<BlockListRegistry>(&mut scenario);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    let payment = coin::mint_for_testing<MYSO>(1000, ts::ctx(&mut scenario));
    msg::send_paid_message_digest(
        &version,
        &group,
        &mut msg_log,
        &paid_registry,
        &social_graph,
        &block_list,
        &group_manager,
        ALICE,
        payment,
        1000,
        b"dedupe",
        1u128,
        &clock,
        ts::ctx(&mut scenario),
    );
    abort
}

#[test]
fun group_chat_skips_paid_policy_gates() {
    let mut scenario = ts::begin(ALICE);
    msg::init_for_testing(ts::ctx(&mut scenario));
    version::init_for_testing(ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, ALICE);
    let mut paid_registry = ts::take_shared<PaidMessagingRegistry>(&mut scenario);
    paid_messaging_policy::set_paid_messaging_policy(
        &mut paid_registry,
        true,
        option::some(1000),
        ts::ctx(&mut scenario),
    );
    ts::return_shared(paid_registry);

    ts::next_tx(&mut scenario, ALICE);
    let version = ts::take_shared<Version>(&mut scenario);
    let mut namespace = ts::take_shared<MessagingNamespace>(&mut scenario);
    let group_manager = ts::take_shared<GroupManager>(&mut scenario);
    let block_list = ts::take_shared<BlockListRegistry>(&mut scenario);
    let (group, encryption_history, msg_log) = msg::create_group(
        &version,
        &mut namespace,
        &group_manager,
        &block_list,
        string::utf8(b"group"),
        string::utf8(TEST_UUID_5),
        b"dek",
        vec_set::empty(),
        ts::ctx(&mut scenario),
    );
    let gid = object::id(&group);
    let msg_log_id = object::id(&msg_log);
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    transfer::public_share_object(msg_log);
    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);
    ts::return_shared(block_list);

    ts::next_tx(&mut scenario, ALICE);
    let version = ts::take_shared<Version>(&mut scenario);
    let group = ts::take_shared_by_id<PermissionedGroup<Messaging>>(&mut scenario, gid);
    let mut msg_log = ts::take_shared_by_id<MessageLog>(&mut scenario, msg_log_id);
    let paid_registry = ts::take_shared<PaidMessagingRegistry>(&mut scenario);
    let social_graph = ts::take_shared<SocialGraph>(&mut scenario);
    let group_manager = ts::take_shared<GroupManager>(&mut scenario);
    let block_list = ts::take_shared<BlockListRegistry>(&mut scenario);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    let payment = coin::mint_for_testing<MYSO>(1, ts::ctx(&mut scenario));
    msg::send_paid_message_digest(
        &version,
        &group,
        &mut msg_log,
        &paid_registry,
        &social_graph,
        &block_list,
        &group_manager,
        BOB,
        payment,
        1,
        b"dedupe",
        1u128,
        &clock,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(version);
    ts::return_shared(group);
    ts::return_shared(msg_log);
    ts::return_shared(paid_registry);
    ts::return_shared(social_graph);
    ts::return_shared(group_manager);
    ts::return_shared(block_list);
    destroy(clock);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = block_list::EBlocked)]
fun blocked_peer_cannot_create_dm() {
    let mut scenario = ts::begin(ALICE);
    msg::init_for_testing(ts::ctx(&mut scenario));
    version::init_for_testing(ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, ALICE);
    let mut block_list = ts::take_shared<BlockListRegistry>(&mut scenario);
    let mut social_graph = ts::take_shared<SocialGraph>(&mut scenario);
    block_list::block_wallet(&mut block_list, &mut social_graph, BOB, ts::ctx(&mut scenario));
    ts::return_shared(block_list);
    ts::return_shared(social_graph);

    ts::next_tx(&mut scenario, BOB);
    let version = ts::take_shared<Version>(&mut scenario);
    let mut namespace = ts::take_shared<MessagingNamespace>(&mut scenario);
    let group_manager = ts::take_shared<GroupManager>(&mut scenario);
    let block_list = ts::take_shared<BlockListRegistry>(&mut scenario);
    let mut members = vec_set::empty();
    members.insert(ALICE);
    let (_group, _eh, _ml) = msg::create_group(
        &version,
        &mut namespace,
        &group_manager,
        &block_list,
        string::utf8(b"dm"),
        string::utf8(TEST_UUID_6),
        b"dek",
        members,
        ts::ctx(&mut scenario),
    );
    abort
}

#[test, expected_failure(abort_code = block_list::EBlocked)]
fun blocked_peer_cannot_send_paid_dm() {
    let mut scenario = ts::begin(ALICE);
    msg::init_for_testing(ts::ctx(&mut scenario));
    version::init_for_testing(ts::ctx(&mut scenario));

    let (gid, msg_log_id) = setup_dm(&mut scenario, BOB, ALICE, TEST_UUID_7);

    ts::next_tx(&mut scenario, ALICE);
    let mut block_list = ts::take_shared<BlockListRegistry>(&mut scenario);
    let mut social_graph = ts::take_shared<SocialGraph>(&mut scenario);
    block_list::block_wallet(&mut block_list, &mut social_graph, BOB, ts::ctx(&mut scenario));
    ts::return_shared(block_list);
    ts::return_shared(social_graph);

    ts::next_tx(&mut scenario, BOB);
    let version = ts::take_shared<Version>(&mut scenario);
    let group = ts::take_shared_by_id<PermissionedGroup<Messaging>>(&mut scenario, gid);
    let mut msg_log = ts::take_shared_by_id<MessageLog>(&mut scenario, msg_log_id);
    let paid_registry = ts::take_shared<PaidMessagingRegistry>(&mut scenario);
    let social_graph = ts::take_shared<SocialGraph>(&mut scenario);
    let group_manager = ts::take_shared<GroupManager>(&mut scenario);
    let block_list = ts::take_shared<BlockListRegistry>(&mut scenario);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    let payment = coin::mint_for_testing<MYSO>(1000, ts::ctx(&mut scenario));
    msg::send_paid_message_digest(
        &version,
        &group,
        &mut msg_log,
        &paid_registry,
        &social_graph,
        &block_list,
        &group_manager,
        ALICE,
        payment,
        1000,
        b"dedupe",
        1u128,
        &clock,
        ts::ctx(&mut scenario),
    );
    abort
}

#[test, expected_failure(abort_code = block_list::EBlocked)]
fun blocker_cannot_send_paid_dm_to_blocked() {
    let mut scenario = ts::begin(ALICE);
    msg::init_for_testing(ts::ctx(&mut scenario));
    version::init_for_testing(ts::ctx(&mut scenario));

    let (gid, msg_log_id) = setup_dm(&mut scenario, ALICE, BOB, TEST_UUID_8);

    ts::next_tx(&mut scenario, ALICE);
    let mut block_list = ts::take_shared<BlockListRegistry>(&mut scenario);
    let mut social_graph = ts::take_shared<SocialGraph>(&mut scenario);
    block_list::block_wallet(&mut block_list, &mut social_graph, BOB, ts::ctx(&mut scenario));
    ts::return_shared(block_list);
    ts::return_shared(social_graph);

    ts::next_tx(&mut scenario, ALICE);
    let version = ts::take_shared<Version>(&mut scenario);
    let group = ts::take_shared_by_id<PermissionedGroup<Messaging>>(&mut scenario, gid);
    let mut msg_log = ts::take_shared_by_id<MessageLog>(&mut scenario, msg_log_id);
    let paid_registry = ts::take_shared<PaidMessagingRegistry>(&mut scenario);
    let social_graph = ts::take_shared<SocialGraph>(&mut scenario);
    let group_manager = ts::take_shared<GroupManager>(&mut scenario);
    let block_list = ts::take_shared<BlockListRegistry>(&mut scenario);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    let payment = coin::mint_for_testing<MYSO>(1000, ts::ctx(&mut scenario));
    msg::send_paid_message_digest(
        &version,
        &group,
        &mut msg_log,
        &paid_registry,
        &social_graph,
        &block_list,
        &group_manager,
        BOB,
        payment,
        1000,
        b"dedupe",
        1u128,
        &clock,
        ts::ctx(&mut scenario),
    );
    abort
}

#[test]
fun paid_send_succeeds_after_unblock() {
    let mut scenario = ts::begin(ALICE);
    msg::init_for_testing(ts::ctx(&mut scenario));
    version::init_for_testing(ts::ctx(&mut scenario));

    let (gid, msg_log_id) = setup_dm(&mut scenario, BOB, ALICE, TEST_UUID_9);

    ts::next_tx(&mut scenario, ALICE);
    let mut block_list = ts::take_shared<BlockListRegistry>(&mut scenario);
    let mut social_graph = ts::take_shared<SocialGraph>(&mut scenario);
    block_list::block_wallet(&mut block_list, &mut social_graph, BOB, ts::ctx(&mut scenario));
    block_list::unblock_wallet(&mut block_list, BOB, ts::ctx(&mut scenario));
    ts::return_shared(block_list);
    ts::return_shared(social_graph);

    ts::next_tx(&mut scenario, BOB);
    let version = ts::take_shared<Version>(&mut scenario);
    let group = ts::take_shared_by_id<PermissionedGroup<Messaging>>(&mut scenario, gid);
    let mut msg_log = ts::take_shared_by_id<MessageLog>(&mut scenario, msg_log_id);
    let paid_registry = ts::take_shared<PaidMessagingRegistry>(&mut scenario);
    let social_graph = ts::take_shared<SocialGraph>(&mut scenario);
    let group_manager = ts::take_shared<GroupManager>(&mut scenario);
    let block_list = ts::take_shared<BlockListRegistry>(&mut scenario);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    let payment = coin::mint_for_testing<MYSO>(1000, ts::ctx(&mut scenario));
    msg::send_paid_message_digest(
        &version,
        &group,
        &mut msg_log,
        &paid_registry,
        &social_graph,
        &block_list,
        &group_manager,
        ALICE,
        payment,
        1000,
        b"dedupe",
        1u128,
        &clock,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(version);
    ts::return_shared(group);
    ts::return_shared(msg_log);
    ts::return_shared(paid_registry);
    ts::return_shared(social_graph);
    ts::return_shared(group_manager);
    ts::return_shared(block_list);
    destroy(clock);
    ts::end(scenario);
}
