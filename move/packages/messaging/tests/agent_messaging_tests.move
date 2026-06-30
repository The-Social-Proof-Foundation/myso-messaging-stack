#[test_only]
#[allow(duplicate_alias, unused_use, unused_mut_ref, unused_let_mut)]
module messaging::agent_messaging_tests;

use std::option;
use std::string;
use std::unit_test::{assert_eq, destroy};

use myso::clock::{Self, Clock};
use myso::coin;
use myso::myso::MYSO;
use myso::object;
use myso::test_scenario as ts;
use myso::vec_set;

use messaging::group_leaver::GroupLeaver;
use messaging::group_manager::{Self, GroupManager};
use messaging::encryption_history::EncryptionHistory;
use messaging::message_log::MessageLog;
use messaging::messaging::{
    Self as msg,
    Messaging,
    MessagingNamespace,
    MessagingReader,
    MessagingSender,
};
use messaging::metadata;
use messaging::mydata_policies;
use messaging::paid_messaging_policy::{Self, PaidMessagingRegistry};
use messaging::version::{Self, Version};
use myso::permissioned_group::{PermissionedGroup, PermissionsAdmin};

use social_contracts::block_list::{Self, BlockListRegistry};
use social_contracts::memory::{Self, MemoryAccount, MemoryRegistry, SubAgent, AgenticOrganization};
use social_contracts::memory_test_helpers;
use social_contracts::platform::{Self, Platform, PlatformRegistry};
use social_contracts::profile::{Self, UsernameRegistry};
use social_contracts::social_graph::{Self, SocialGraph};

const ADMIN: address = @0xAD;
const AUTHOR: address = @0x1;
const BOB: address = @0xB0B;
const CAROL: address = @0xCA01;
const AGENT_ADDR: address = @0xA11CE;
const CAROL_AGENT_ADDR: address = @0xCA_A11CE;
const AGENT_PUBKEY: vector<u8> = x"0101010101010101010101010101010101010101010101010101010101010101";
const CAROL_AGENT_PUBKEY: vector<u8> = x"0202020202020202020202020202020202020202020202020202020202020202";
const TEST_ENCRYPTED_DEK: vector<u8> = b"test_encrypted_dek";
const TEST_UUID: vector<u8> = b"550e8400-e29b-41d4-a716-446655440010";
const TEST_UUID_PAID: vector<u8> = b"550e8400-e29b-41d4-a716-446655440011";
const TEST_UUID_CROSS: vector<u8> = b"550e8400-e29b-41d4-a716-446655440012";
const TEST_UUID_FOLLOWER: vector<u8> = b"550e8400-e29b-41d4-a716-446655440013";
const TEST_GROUP_NAME: vector<u8> = b"Agent Chat";

fun setup(scenario: &mut ts::Scenario) {
    ts::next_tx(scenario, ADMIN);
    {
        let clock = clock::create_for_testing(ts::ctx(scenario));
        profile::init_for_testing(&clock, ts::ctx(scenario));
        platform::test_init(ts::ctx(scenario));
        msg::init_for_testing_with_clock(&clock, ts::ctx(scenario));
        version::init_for_testing(ts::ctx(scenario));
        clock::share_for_testing(clock);
    };

    ts::next_tx(scenario, ADMIN);
    {
        let mut registry = ts::take_shared<PlatformRegistry>(scenario);
        let clock = ts::take_shared<Clock>(scenario);
        platform::create_platform(
            &mut registry,
            string::utf8(b"Messaging Platform"),
            string::utf8(b"tagline"),
            string::utf8(b"desc"),
            string::utf8(b"https://example.com/logo.png"),
            string::utf8(b"https://example.com/tos"),
            string::utf8(b"https://example.com/privacy"),
            vector[string::utf8(b"web")],
            vector[string::utf8(b"https://example.com")],
            string::utf8(b"Social Network"),
            option::none(),
            3,
            string::utf8(b"2023-01-01"),
            false,
            option::none(),
            option::none(),
            option::none(),
            option::none(),
            option::none(),
            option::none(),
            option::none(),
            option::none(),
            option::none(),
            &clock,
            ts::ctx(scenario),
        );
        ts::return_shared(clock);
        ts::return_shared(registry);
    };

    ts::next_tx(scenario, ADMIN);
    {
        let platform_obj = ts::take_shared<Platform>(scenario);
        let mut registry = ts::take_shared<PlatformRegistry>(scenario);
        let platform_id = object::uid_to_address(platform::id(&platform_obj));
        platform::test_set_approval(&mut registry, platform_id, true);
        ts::return_shared(platform_obj);
        ts::return_shared(registry);
    };

    ts::next_tx(scenario, AUTHOR);
    {
        let mut registry = ts::take_shared<UsernameRegistry>(scenario);
        let mut memory_registry = ts::take_shared<MemoryRegistry>(scenario);
        let clock = ts::take_shared<Clock>(scenario);
        profile::create_profile(
            &mut registry,
            &mut memory_registry,
            string::utf8(b"Author"),
            string::utf8(b"author"),
            string::utf8(b"bio"),
            b"",
            b"",
            &clock,
            ts::ctx(scenario),
        );
        ts::return_shared(clock);
        ts::return_shared(memory_registry);
        ts::return_shared(registry);
    };

    ts::next_tx(scenario, AUTHOR);
    {
        let mut platform_obj = ts::take_shared<Platform>(scenario);
        platform::test_join_platform(&mut platform_obj, AUTHOR);
        ts::return_shared(platform_obj);
    };
}

fun register_agent(
    memory_account: &mut MemoryAccount,
    organization: &mut AgenticOrganization,
    platform_id: address,
    clock: &Clock,
    ctx: &mut myso::tx_context::TxContext,
) {
    memory::register_sub_agent(
        memory_account,
        organization,
        AGENT_PUBKEY,
        AGENT_ADDR,
        string::utf8(b"messaging-agent"),
        memory::class_delegated_ai(),
        0,
        memory::cap_message_send() | memory::cap_message_read(),
        memory::cap_message_send() | memory::cap_message_read(),
        3,
        0,
        option::none(),
        option::some(platform_id),
        option::none(),
        clock,
        ctx,
    );
}

fun setup_carol_with_agent(scenario: &mut ts::Scenario) {
    ts::next_tx(scenario, CAROL);
    {
        let mut registry = ts::take_shared<UsernameRegistry>(scenario);
        let mut memory_registry = ts::take_shared<MemoryRegistry>(scenario);
        let clock = ts::take_shared<Clock>(scenario);
        profile::create_profile(
            &mut registry,
            &mut memory_registry,
            string::utf8(b"Carol"),
            string::utf8(b"carol"),
            string::utf8(b"bio"),
            b"",
            b"",
            &clock,
            ts::ctx(scenario),
        );
        ts::return_shared(clock);
        ts::return_shared(memory_registry);
        ts::return_shared(registry);
    };

    ts::next_tx(scenario, CAROL);
    {
        let mut platform_obj = ts::take_shared<Platform>(scenario);
        platform::test_join_platform(&mut platform_obj, CAROL);
        ts::return_shared(platform_obj);
    };

    ts::next_tx(scenario, CAROL);
    {
        memory_test_helpers::create_default_org_in_tx(scenario);
    };

    ts::next_tx(scenario, CAROL);
    {
        let platform_obj = ts::take_shared<Platform>(scenario);
        let platform_id = object::uid_to_address(platform::id(&platform_obj));
        ts::return_shared(platform_obj);

        let mut org = memory_test_helpers::take_created_org(scenario);
        let mut memory_account = ts::take_shared<MemoryAccount>(scenario);
        let clock = ts::take_shared<Clock>(scenario);
        memory::register_sub_agent(
            &mut memory_account,
            &mut org,
            CAROL_AGENT_PUBKEY,
            CAROL_AGENT_ADDR,
            string::utf8(b"carol-agent"),
            memory::class_delegated_ai(),
            0,
            memory::cap_message_send() | memory::cap_message_read(),
            memory::cap_message_send() | memory::cap_message_read(),
            3,
            0,
            option::none(),
            option::some(platform_id),
            option::none(),
            &clock,
            ts::ctx(scenario),
        );
        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(org);
    };
}

#[test]
fun agent_creates_dm_with_human_peer() {
    let mut scenario = ts::begin(AUTHOR);
    setup(&mut scenario);

    ts::next_tx(&mut scenario, AUTHOR);
    {
        memory_test_helpers::create_default_org_in_tx(&mut scenario);
    };

    ts::next_tx(&mut scenario, AUTHOR);
    {
        let platform_obj = ts::take_shared<Platform>(&scenario);
        let platform_id = object::uid_to_address(platform::id(&platform_obj));
        let mut org = memory_test_helpers::take_created_org(&mut scenario);
        let mut memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);
        register_agent(&mut memory_account, &mut org, platform_id, &clock, ts::ctx(&mut scenario));
        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(org);
        ts::return_shared(platform_obj);
    };

    ts::next_tx(&mut scenario, AGENT_ADDR);
    {
        let version = ts::take_shared<Version>(&scenario);
        let mut namespace = ts::take_shared<MessagingNamespace>(&scenario);
        let group_manager = ts::take_shared<GroupManager>(&scenario);
        let group_leaver = ts::take_shared<GroupLeaver>(&scenario);
        let block_list = ts::take_shared<BlockListRegistry>(&scenario);
        let platform = ts::take_shared<Platform>(&scenario);
        let memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);

        let mut members = vec_set::empty<address>();
        vec_set::insert(&mut members, BOB);

        let (group, encryption_history, msg_log) = msg::create_agent_group(
            &version,
            &mut namespace,
            &group_manager,
            &group_leaver,
            &block_list,
            &platform,
            &memory_account,
            &memory_account,
            string::utf8(TEST_GROUP_NAME),
            string::utf8(TEST_UUID),
            TEST_ENCRYPTED_DEK,
            members,
            &clock,
            ts::ctx(&mut scenario),
        );

        assert!(group.has_permission<Messaging, MessagingSender>(AGENT_ADDR), 0);
        assert!(group.has_permission<Messaging, MessagingReader>(AGENT_ADDR), 1);
        assert!(!group.has_permission<Messaging, PermissionsAdmin>(AGENT_ADDR), 2);
        assert!(group.has_permission<Messaging, MessagingReader>(AUTHOR), 3);
        assert!(group.has_permission<Messaging, PermissionsAdmin>(AUTHOR), 4);
        assert!(group.has_permission<Messaging, MessagingSender>(BOB), 5);
        assert!(group.has_permission<Messaging, MessagingReader>(BOB), 6);
        assert!(!group.has_permission<Messaging, MessagingSender>(AUTHOR), 7);

        let m = group_manager::borrow_metadata<Messaging>(&group_manager, &group);
        let agent_chat_key = string::utf8(b"agent_chat");
        let agent_chat = metadata::get_data_value(m, &agent_chat_key);
        assert!(option::is_some(&agent_chat), 8);

        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(platform);
        ts::return_shared(block_list);
        ts::return_shared(group_leaver);
        ts::return_shared(group_manager);
        ts::return_shared(namespace);
        ts::return_shared(version);
        destroy(group);
        destroy(encryption_history);
        destroy(msg_log);
    };

    scenario.end();
}

#[test]
#[expected_failure(abort_code = social_contracts::memory::ESubAgentMissingCap)]
fun agent_without_message_cap_cannot_create_group() {
    let mut scenario = ts::begin(AUTHOR);
    setup(&mut scenario);

    ts::next_tx(&mut scenario, AUTHOR);
    {
        memory_test_helpers::create_default_org_in_tx(&mut scenario);
    };

    ts::next_tx(&mut scenario, AUTHOR);
    {
        let platform_obj = ts::take_shared<Platform>(&scenario);
        let platform_id = object::uid_to_address(platform::id(&platform_obj));
        let mut org = memory_test_helpers::take_created_org(&mut scenario);
        let mut memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);
        memory::register_sub_agent(
            &mut memory_account,
            &mut org,
            AGENT_PUBKEY,
            AGENT_ADDR,
            string::utf8(b"no-cap-agent"),
            memory::class_delegated_ai(),
            0,
            memory::cap_memory_read(),
            memory::cap_memory_read(),
            3,
            0,
            option::none(),
            option::some(platform_id),
            option::none(),
            &clock,
            ts::ctx(&mut scenario),
        );
        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(org);
        ts::return_shared(platform_obj);
    };

    ts::next_tx(&mut scenario, AGENT_ADDR);
    {
        let version = ts::take_shared<Version>(&scenario);
        let mut namespace = ts::take_shared<MessagingNamespace>(&scenario);
        let group_manager = ts::take_shared<GroupManager>(&scenario);
        let group_leaver = ts::take_shared<GroupLeaver>(&scenario);
        let block_list = ts::take_shared<BlockListRegistry>(&scenario);
        let platform = ts::take_shared<Platform>(&scenario);
        let memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);

        let members = vec_set::empty<address>();
        let (_group, _eh, _ml) = msg::create_agent_group(
            &version,
            &mut namespace,
            &group_manager,
            &group_leaver,
            &block_list,
            &platform,
            &memory_account,
            &memory_account,
            string::utf8(TEST_GROUP_NAME),
            string::utf8(TEST_UUID),
            TEST_ENCRYPTED_DEK,
            members,
            &clock,
            ts::ctx(&mut scenario),
        );

        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(platform);
        ts::return_shared(block_list);
        ts::return_shared(group_leaver);
        ts::return_shared(group_manager);
        ts::return_shared(namespace);
        ts::return_shared(version);
        destroy(_group);
        destroy(_eh);
        destroy(_ml);
    };

    scenario.end();
}

#[test]
fun principal_mydata_oversight_fallback() {
    let mut scenario = ts::begin(AUTHOR);
    setup(&mut scenario);

    ts::next_tx(&mut scenario, AUTHOR);
    {
        memory_test_helpers::create_default_org_in_tx(&mut scenario);
    };

    ts::next_tx(&mut scenario, AUTHOR);
    {
        let platform_obj = ts::take_shared<Platform>(&scenario);
        let platform_id = object::uid_to_address(platform::id(&platform_obj));
        let mut org = memory_test_helpers::take_created_org(&mut scenario);
        let mut memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);
        register_agent(&mut memory_account, &mut org, platform_id, &clock, ts::ctx(&mut scenario));
        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(org);
        ts::return_shared(platform_obj);
    };

    ts::next_tx(&mut scenario, AGENT_ADDR);
    {
        let version = ts::take_shared<Version>(&scenario);
        let mut namespace = ts::take_shared<MessagingNamespace>(&scenario);
        let group_manager = ts::take_shared<GroupManager>(&scenario);
        let group_leaver = ts::take_shared<GroupLeaver>(&scenario);
        let block_list = ts::take_shared<BlockListRegistry>(&scenario);
        let platform = ts::take_shared<Platform>(&scenario);
        let memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);

        msg::create_agent_and_share_group(
            &version,
            &mut namespace,
            &group_manager,
            &group_leaver,
            &block_list,
            &platform,
            &memory_account,
            &memory_account,
            string::utf8(TEST_GROUP_NAME),
            string::utf8(TEST_UUID),
            TEST_ENCRYPTED_DEK,
            vector[],
            &clock,
            ts::ctx(&mut scenario),
        );

        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(platform);
        ts::return_shared(block_list);
        ts::return_shared(group_leaver);
        ts::return_shared(group_manager);
        ts::return_shared(namespace);
        ts::return_shared(version);
    };

    ts::next_tx(&mut scenario, AUTHOR);
    {
        let version = ts::take_shared<Version>(&scenario);
        let group = ts::take_shared<PermissionedGroup<Messaging>>(&scenario);
        let encryption_history = ts::take_shared<EncryptionHistory>(&scenario);
        let memory_account = ts::take_shared<MemoryAccount>(&scenario);

        let mut bytes = object::id_to_address(&object::id(&group)).to_bytes();
        bytes.append(myso::bcs::to_bytes(&0u64));
        mydata_policies::mydata_approve_reader_with_oversight(
            bytes,
            &version,
            &group,
            &encryption_history,
            &memory_account,
            AGENT_ADDR,
            ts::ctx(&mut scenario),
        );

        ts::return_shared(memory_account);
        ts::return_shared(encryption_history);
        ts::return_shared(group);
        ts::return_shared(version);
    };

    scenario.end();
}

#[test]
#[expected_failure(abort_code = messaging::messaging::ENotPermitted)]
fun agent_cannot_bypass_via_human_create_group() {
    let mut scenario = ts::begin(AUTHOR);
    setup(&mut scenario);

    ts::next_tx(&mut scenario, AUTHOR);
    {
        memory_test_helpers::create_default_org_in_tx(&mut scenario);
    };

    ts::next_tx(&mut scenario, AUTHOR);
    {
        let platform_obj = ts::take_shared<Platform>(&scenario);
        let platform_id = object::uid_to_address(platform::id(&platform_obj));
        let mut org = memory_test_helpers::take_created_org(&mut scenario);
        let mut memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);
        register_agent(&mut memory_account, &mut org, platform_id, &clock, ts::ctx(&mut scenario));
        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(org);
        ts::return_shared(platform_obj);
    };

    ts::next_tx(&mut scenario, AGENT_ADDR);
    {
        let version = ts::take_shared<Version>(&scenario);
        let mut namespace = ts::take_shared<MessagingNamespace>(&scenario);
        let group_manager = ts::take_shared<GroupManager>(&scenario);
        let block_list = ts::take_shared<BlockListRegistry>(&scenario);
        let memory_account = ts::take_shared<MemoryAccount>(&scenario);

        let (_group, _eh, _ml) = msg::create_group(
            &version,
            &mut namespace,
            &group_manager,
            &block_list,
            &memory_account,
            string::utf8(TEST_GROUP_NAME),
            string::utf8(TEST_UUID),
            TEST_ENCRYPTED_DEK,
            vec_set::empty(),
            ts::ctx(&mut scenario),
        );

        ts::return_shared(memory_account);
        ts::return_shared(block_list);
        ts::return_shared(group_manager);
        ts::return_shared(namespace);
        ts::return_shared(version);
        destroy(_group);
        destroy(_eh);
        destroy(_ml);
    };

    scenario.end();
}

#[test]
fun cross_principal_agent_peer_gets_permissions_and_oversight() {
    let mut scenario = ts::begin(AUTHOR);
    setup(&mut scenario);

    ts::next_tx(&mut scenario, AUTHOR);
    {
        memory_test_helpers::create_default_org_in_tx(&mut scenario);
    };

    ts::next_tx(&mut scenario, AUTHOR);
    {
        let platform_obj = ts::take_shared<Platform>(&scenario);
        let platform_id = object::uid_to_address(platform::id(&platform_obj));
        let mut org = memory_test_helpers::take_created_org(&mut scenario);
        let mut memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);
        register_agent(&mut memory_account, &mut org, platform_id, &clock, ts::ctx(&mut scenario));
        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(org);
        ts::return_shared(platform_obj);
    };

    setup_carol_with_agent(&mut scenario);

    ts::next_tx(&mut scenario, AGENT_ADDR);
    {
        let version = ts::take_shared<Version>(&scenario);
        let mut namespace = ts::take_shared<MessagingNamespace>(&scenario);
        let group_manager = ts::take_shared<GroupManager>(&scenario);
        let group_leaver = ts::take_shared<GroupLeaver>(&scenario);
        let block_list = ts::take_shared<BlockListRegistry>(&scenario);
        let platform = ts::take_shared<Platform>(&scenario);
        let memory_one = ts::take_shared<MemoryAccount>(&scenario);
        let memory_two = ts::take_shared<MemoryAccount>(&scenario);
        let (author_memory, carol_memory) = if (memory::owner(&memory_one) == AUTHOR) {
            (memory_one, memory_two)
        } else {
            (memory_two, memory_one)
        };
        let clock = ts::take_shared<Clock>(&scenario);

        let mut members = vec_set::empty<address>();
        vec_set::insert(&mut members, CAROL_AGENT_ADDR);

        let (group, encryption_history, msg_log) = msg::create_agent_group(
            &version,
            &mut namespace,
            &group_manager,
            &group_leaver,
            &block_list,
            &platform,
            &author_memory,
            &carol_memory,
            string::utf8(TEST_GROUP_NAME),
            string::utf8(TEST_UUID_CROSS),
            TEST_ENCRYPTED_DEK,
            members,
            &clock,
            ts::ctx(&mut scenario),
        );

        assert!(group.has_permission<Messaging, MessagingSender>(CAROL_AGENT_ADDR), 0);
        assert!(group.has_permission<Messaging, MessagingReader>(CAROL_AGENT_ADDR), 1);
        assert!(group.has_permission<Messaging, PermissionsAdmin>(CAROL), 2);
        assert!(group.has_permission<Messaging, MessagingReader>(CAROL), 3);

        ts::return_shared(clock);
        ts::return_shared(carol_memory);
        ts::return_shared(author_memory);
        ts::return_shared(platform);
        ts::return_shared(block_list);
        ts::return_shared(group_leaver);
        ts::return_shared(group_manager);
        ts::return_shared(namespace);
        ts::return_shared(version);
        destroy(group);
        destroy(encryption_history);
        destroy(msg_log);
    };

    scenario.end();
}

#[test]
fun agent_paid_dm_stranger_at_min_succeeds() {
    let mut scenario = ts::begin(AUTHOR);
    setup(&mut scenario);

    ts::next_tx(&mut scenario, AUTHOR);
    {
        memory_test_helpers::create_default_org_in_tx(&mut scenario);
    };

    ts::next_tx(&mut scenario, AUTHOR);
    {
        let platform_obj = ts::take_shared<Platform>(&scenario);
        let platform_id = object::uid_to_address(platform::id(&platform_obj));
        let mut org = memory_test_helpers::take_created_org(&mut scenario);
        let mut memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);
        register_agent(&mut memory_account, &mut org, platform_id, &clock, ts::ctx(&mut scenario));
        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(org);
        ts::return_shared(platform_obj);
    };

    ts::next_tx(&mut scenario, BOB);
    {
        let mut paid_registry = ts::take_shared<PaidMessagingRegistry>(&scenario);
        paid_messaging_policy::set_paid_messaging_policy(
            &mut paid_registry,
            true,
            option::some(1000),
            ts::ctx(&mut scenario),
        );
        ts::return_shared(paid_registry);
    };

    ts::next_tx(&mut scenario, AGENT_ADDR);
    {
        let version = ts::take_shared<Version>(&scenario);
        let mut namespace = ts::take_shared<MessagingNamespace>(&scenario);
        let group_manager = ts::take_shared<GroupManager>(&scenario);
        let group_leaver = ts::take_shared<GroupLeaver>(&scenario);
        let block_list = ts::take_shared<BlockListRegistry>(&scenario);
        let platform = ts::take_shared<Platform>(&scenario);
        let memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);

        let mut members = vec_set::empty<address>();
        vec_set::insert(&mut members, BOB);

        let (group, encryption_history, msg_log) = msg::create_agent_group(
            &version,
            &mut namespace,
            &group_manager,
            &group_leaver,
            &block_list,
            &platform,
            &memory_account,
            &memory_account,
            string::utf8(TEST_GROUP_NAME),
            string::utf8(TEST_UUID_PAID),
            TEST_ENCRYPTED_DEK,
            members,
            &clock,
            ts::ctx(&mut scenario),
        );
        let _gid = object::id(&group);
        let _msg_log_id = object::id(&msg_log);
        transfer::public_share_object(group);
        transfer::public_share_object(encryption_history);
        transfer::public_share_object(msg_log);

        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(platform);
        ts::return_shared(block_list);
        ts::return_shared(group_leaver);
        ts::return_shared(group_manager);
        ts::return_shared(namespace);
        ts::return_shared(version);
    };

    ts::next_tx(&mut scenario, AGENT_ADDR);
    {
        let version = ts::take_shared<Version>(&scenario);
        let group = ts::take_shared<PermissionedGroup<Messaging>>(&scenario);
        let mut msg_log = ts::take_shared<MessageLog>(&scenario);
        let paid_registry = ts::take_shared<PaidMessagingRegistry>(&scenario);
        let social_graph = ts::take_shared<SocialGraph>(&scenario);
        let group_manager = ts::take_shared<GroupManager>(&scenario);
        let block_list = ts::take_shared<BlockListRegistry>(&scenario);
        let platform = ts::take_shared<Platform>(&scenario);
        let memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);
        let payment = coin::mint_for_testing<MYSO>(1000, ts::ctx(&mut scenario));

        msg::send_agent_paid_message_digest(
            &version,
            &group,
            &mut msg_log,
            &paid_registry,
            &social_graph,
            &block_list,
            &group_manager,
            &platform,
            &memory_account,
            BOB,
            payment,
            1000,
            b"dedupe",
            1u128,
            &clock,
            ts::ctx(&mut scenario),
        );

        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(platform);
        ts::return_shared(block_list);
        ts::return_shared(group_manager);
        ts::return_shared(social_graph);
        ts::return_shared(paid_registry);
        ts::return_shared(msg_log);
        ts::return_shared(group);
        ts::return_shared(version);
    };

    scenario.end();
}

#[test]
#[expected_failure(abort_code = msg::EBelowMinMessageCost)]
fun agent_paid_dm_below_min_fails() {
    let mut scenario = ts::begin(AUTHOR);
    setup(&mut scenario);

    ts::next_tx(&mut scenario, AUTHOR);
    {
        memory_test_helpers::create_default_org_in_tx(&mut scenario);
    };

    ts::next_tx(&mut scenario, AUTHOR);
    {
        let platform_obj = ts::take_shared<Platform>(&scenario);
        let platform_id = object::uid_to_address(platform::id(&platform_obj));
        let mut org = memory_test_helpers::take_created_org(&mut scenario);
        let mut memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);
        register_agent(&mut memory_account, &mut org, platform_id, &clock, ts::ctx(&mut scenario));
        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(org);
        ts::return_shared(platform_obj);
    };

    ts::next_tx(&mut scenario, BOB);
    {
        let mut paid_registry = ts::take_shared<PaidMessagingRegistry>(&scenario);
        paid_messaging_policy::set_paid_messaging_policy(
            &mut paid_registry,
            true,
            option::some(1000),
            ts::ctx(&mut scenario),
        );
        ts::return_shared(paid_registry);
    };

    ts::next_tx(&mut scenario, AGENT_ADDR);
    {
        let version = ts::take_shared<Version>(&scenario);
        let mut namespace = ts::take_shared<MessagingNamespace>(&scenario);
        let group_manager = ts::take_shared<GroupManager>(&scenario);
        let group_leaver = ts::take_shared<GroupLeaver>(&scenario);
        let block_list = ts::take_shared<BlockListRegistry>(&scenario);
        let platform = ts::take_shared<Platform>(&scenario);
        let memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);

        let mut members = vec_set::empty<address>();
        vec_set::insert(&mut members, BOB);

        msg::create_agent_and_share_group(
            &version,
            &mut namespace,
            &group_manager,
            &group_leaver,
            &block_list,
            &platform,
            &memory_account,
            &memory_account,
            string::utf8(TEST_GROUP_NAME),
            string::utf8(TEST_UUID_PAID),
            TEST_ENCRYPTED_DEK,
            vector[BOB],
            &clock,
            ts::ctx(&mut scenario),
        );

        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(platform);
        ts::return_shared(block_list);
        ts::return_shared(group_leaver);
        ts::return_shared(group_manager);
        ts::return_shared(namespace);
        ts::return_shared(version);
    };

    ts::next_tx(&mut scenario, AGENT_ADDR);
    {
        let version = ts::take_shared<Version>(&scenario);
        let group = ts::take_shared<PermissionedGroup<Messaging>>(&scenario);
        let mut msg_log = ts::take_shared<MessageLog>(&scenario);
        let paid_registry = ts::take_shared<PaidMessagingRegistry>(&scenario);
        let social_graph = ts::take_shared<SocialGraph>(&scenario);
        let group_manager = ts::take_shared<GroupManager>(&scenario);
        let block_list = ts::take_shared<BlockListRegistry>(&scenario);
        let platform = ts::take_shared<Platform>(&scenario);
        let memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);
        let payment = coin::mint_for_testing<MYSO>(500, ts::ctx(&mut scenario));

        msg::send_agent_paid_message_digest(
            &version,
            &group,
            &mut msg_log,
            &paid_registry,
            &social_graph,
            &block_list,
            &group_manager,
            &platform,
            &memory_account,
            BOB,
            payment,
            500,
            b"dedupe",
            1u128,
            &clock,
            ts::ctx(&mut scenario),
        );

        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(platform);
        ts::return_shared(block_list);
        ts::return_shared(group_manager);
        ts::return_shared(social_graph);
        ts::return_shared(paid_registry);
        ts::return_shared(msg_log);
        ts::return_shared(group);
        ts::return_shared(version);
    };

    scenario.end();
}

#[test]
#[expected_failure(abort_code = msg::EPaidNotRequiredForFollower)]
fun agent_paid_dm_principal_follower_bypass_fails() {
    let mut scenario = ts::begin(AUTHOR);
    setup(&mut scenario);

    ts::next_tx(&mut scenario, AUTHOR);
    {
        memory_test_helpers::create_default_org_in_tx(&mut scenario);
    };

    ts::next_tx(&mut scenario, AUTHOR);
    {
        let platform_obj = ts::take_shared<Platform>(&scenario);
        let platform_id = object::uid_to_address(platform::id(&platform_obj));
        let mut org = memory_test_helpers::take_created_org(&mut scenario);
        let mut memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);
        register_agent(&mut memory_account, &mut org, platform_id, &clock, ts::ctx(&mut scenario));
        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(org);
        ts::return_shared(platform_obj);
    };

    ts::next_tx(&mut scenario, BOB);
    {
        let mut paid_registry = ts::take_shared<PaidMessagingRegistry>(&scenario);
        paid_messaging_policy::set_paid_messaging_policy(
            &mut paid_registry,
            true,
            option::some(1000),
            ts::ctx(&mut scenario),
        );
        ts::return_shared(paid_registry);
    };

    ts::next_tx(&mut scenario, AUTHOR);
    {
        let mut social_graph = ts::take_shared<SocialGraph>(&scenario);
        social_graph::follow(&mut social_graph, BOB, ts::ctx(&mut scenario));
        ts::return_shared(social_graph);
    };

    ts::next_tx(&mut scenario, AGENT_ADDR);
    {
        let version = ts::take_shared<Version>(&scenario);
        let mut namespace = ts::take_shared<MessagingNamespace>(&scenario);
        let group_manager = ts::take_shared<GroupManager>(&scenario);
        let group_leaver = ts::take_shared<GroupLeaver>(&scenario);
        let block_list = ts::take_shared<BlockListRegistry>(&scenario);
        let platform = ts::take_shared<Platform>(&scenario);
        let memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);

        msg::create_agent_and_share_group(
            &version,
            &mut namespace,
            &group_manager,
            &group_leaver,
            &block_list,
            &platform,
            &memory_account,
            &memory_account,
            string::utf8(TEST_GROUP_NAME),
            string::utf8(TEST_UUID_FOLLOWER),
            TEST_ENCRYPTED_DEK,
            vector[BOB],
            &clock,
            ts::ctx(&mut scenario),
        );

        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(platform);
        ts::return_shared(block_list);
        ts::return_shared(group_leaver);
        ts::return_shared(group_manager);
        ts::return_shared(namespace);
        ts::return_shared(version);
    };

    ts::next_tx(&mut scenario, AGENT_ADDR);
    {
        let version = ts::take_shared<Version>(&scenario);
        let group = ts::take_shared<PermissionedGroup<Messaging>>(&scenario);
        let mut msg_log = ts::take_shared<MessageLog>(&scenario);
        let paid_registry = ts::take_shared<PaidMessagingRegistry>(&scenario);
        let social_graph = ts::take_shared<SocialGraph>(&scenario);
        let group_manager = ts::take_shared<GroupManager>(&scenario);
        let block_list = ts::take_shared<BlockListRegistry>(&scenario);
        let platform = ts::take_shared<Platform>(&scenario);
        let memory_account = ts::take_shared<MemoryAccount>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);
        let payment = coin::mint_for_testing<MYSO>(1000, ts::ctx(&mut scenario));

        msg::send_agent_paid_message_digest(
            &version,
            &group,
            &mut msg_log,
            &paid_registry,
            &social_graph,
            &block_list,
            &group_manager,
            &platform,
            &memory_account,
            BOB,
            payment,
            1000,
            b"dedupe",
            1u128,
            &clock,
            ts::ctx(&mut scenario),
        );

        ts::return_shared(clock);
        ts::return_shared(memory_account);
        ts::return_shared(platform);
        ts::return_shared(block_list);
        ts::return_shared(group_manager);
        ts::return_shared(social_graph);
        ts::return_shared(paid_registry);
        ts::return_shared(msg_log);
        ts::return_shared(group);
        ts::return_shared(version);
    };

    scenario.end();
}
