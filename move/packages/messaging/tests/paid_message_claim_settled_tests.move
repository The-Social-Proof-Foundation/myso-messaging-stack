#[test_only]
module messaging::paid_message_claim_settled_tests;

use messaging::group_manager::GroupManager;
use messaging::message_log::{Self, MessageLog};
use messaging::paid_messaging_policy::PaidMessagingRegistry;
use messaging::messaging::{
    Self,
    Messaging,
    MessagingNamespace,
};
use messaging::version::{Self, Version};
use myso::permissioned_group::PermissionedGroup;
use social_contracts::block_list::BlockListRegistry;
use social_contracts::social_graph::SocialGraph;
use myso::clock;
use myso::coin;
use myso::myso::MYSO;
use myso::test_scenario as ts;
use myso::vec_set;
use std::string;
use std::unit_test::{assert_eq, destroy};

const ALICE: address = @0xA11CE;
const PLATFORM_ADDR: address = @0xBADF00;
const ECO_ADDR: address = @0xEC0000;
const TEST_UUID: vector<u8> = b"550e8400-e29b-41d4-a716-4466554400ab";

#[test]
fun reply_claim_settled_self_recipient_flow() {
    let mut s = ts::begin(ALICE);

    s.next_tx(ALICE);
    messaging::init_for_testing(s.ctx());
    version::init_for_testing(s.ctx());

    s.next_tx(ALICE);
    let version = s.take_shared<Version>();
    let mut namespace = s.take_shared<MessagingNamespace>();
    let group_manager = s.take_shared<GroupManager>();
    let block_list = s.take_shared<BlockListRegistry>();
    let (group, encryption_history, msg_log) = messaging::create_group_unchecked(
        &version,
        &mut namespace,
        &group_manager,
        &block_list,
        string::utf8(b"Paid settled"),
        string::utf8(TEST_UUID),
        b"dek",
        vec_set::empty(),
        s.ctx(),
    );

    let msg_log_id = object::id(&msg_log);
    let gid = object::id(&group);
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    transfer::public_share_object(msg_log);
    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);
    ts::return_shared(block_list);
    s.next_tx(ALICE);
    let version = s.take_shared<Version>();
    let group = s.take_shared_by_id<PermissionedGroup<Messaging>>(gid);
    let mut msg_log = s.take_shared_by_id<MessageLog>(msg_log_id);
    let paid_registry = s.take_shared<PaidMessagingRegistry>();
    let social_graph = s.take_shared<SocialGraph>();
    let group_manager = s.take_shared<GroupManager>();
    let block_list = s.take_shared<BlockListRegistry>();
    let mut clock = clock::create_for_testing(s.ctx());
    clock::set_for_testing(&mut clock, 1);
    let payment = coin::mint_for_testing<MYSO>(10_000, s.ctx());
    messaging::send_paid_message_digest(
        &version,
        &group,
        &mut msg_log,
        &paid_registry,
        &social_graph,
        &block_list,
        &group_manager,
        ALICE,
        payment,
        10_000,
        b"dedupe-send",
        1u128,
        &clock,
        s.ctx(),
    );
    ts::return_shared(version);
    ts::return_shared(group);
    ts::return_shared(msg_log);
    ts::return_shared(paid_registry);
    ts::return_shared(social_graph);
    ts::return_shared(group_manager);
    ts::return_shared(block_list);
    destroy(clock);

    s.next_tx(ALICE);
    let version = s.take_shared<Version>();
    let group = s.take_shared_by_id<PermissionedGroup<Messaging>>(gid);
    let mut msg_log = s.take_shared_by_id<MessageLog>(msg_log_id);
    let block_list = s.take_shared<BlockListRegistry>();
    let mut clock = clock::create_for_testing(s.ctx());
    clock::set_for_testing(&mut clock, 2);
    messaging::reply_to_paid_message_claim_settled(
        &version,
        &group,
        &mut msg_log,
        &block_list,
        0,
        10,
        b"dedupe-claim",
        2u128,
        &clock,
        PLATFORM_ADDR,
        ECO_ADDR,
        s.ctx(),
    );
    ts::return_shared(version);
    ts::return_shared(group);
    ts::return_shared(msg_log);
    ts::return_shared(block_list);
    destroy(clock);

    s.next_tx(ALICE);
    let msg_log = s.take_shared_by_id<MessageLog>(msg_log_id);
    assert_eq!(message_log::next_seq(&msg_log), 1);
    ts::return_shared(msg_log);

    s.end();
}
