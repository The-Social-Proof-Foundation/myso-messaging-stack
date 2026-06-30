/// Module: messaging
///
/// Public-facing module for the messaging package. All external interactions
/// should go through this module.
///
/// Wraps `permissions_group` to provide messaging-specific permission management,
/// `encryption_history` for key rotation, and `message_log` for **paid** `MYSO` escrow only.
///
/// ## Permissions
///
/// From groups (auto-granted to creator):
/// - `PermissionsAdmin`: Manages core permissions (from permissioned_groups package)
/// - `ExtensionPermissionsAdmin`: Manages extension permissions (from other packages)
///
/// Messaging-specific:
/// - `MessagingSender`: Send messages
/// - `MessagingReader`: Read/decrypt messages
/// - `MessagingEditor`: Edit messages
/// - `MessagingDeleter`: Delete messages
/// - `EncryptionKeyRotator`: Rotate encryption keys
/// - `GroupHandleAdmin`: Register or clear this group's handle in [`group_handle_registry::GroupHandleRegistry`]
/// - `MetadataAdmin`: Edit group metadata (name, data)
///
/// ## Security
///
/// - Membership is defined by having at least one permission
/// - Granting a permission implicitly adds the member if they don't exist
/// - Revoking the last permission automatically removes the member
///
module messaging::messaging;

use messaging::encryption_history::{Self, EncryptionHistory, EncryptionKeyRotator};
use messaging::group_leaver::{Self, GroupLeaver};
use messaging::group_handle_registry::{Self, GroupHandleRegistry};
use messaging::group_manager::{Self, GroupManager};
use messaging::message_log::{Self, MessageLog};
use messaging::metadata;
use messaging::paid_messaging_policy::{Self, PaidMessagingRegistry};
use messaging::version::{Self as version, Version};
use social_contracts::block_list::{Self, BlockListRegistry};
use social_contracts::memory::{Self, ActingContext, MemoryAccount};
use social_contracts::platform::{Self, Platform};
use social_contracts::social_graph::{Self, SocialGraph};
use myso::permissioned_group::{
    Self,
    PermissionedGroup,
    PermissionsAdmin,
    ObjectAdmin,
};
use myso::clock::{Self, Clock};
use myso::coin::{Self, Coin};
use myso::derived_object;
use myso::event;
use myso::hex;
use myso::myso::MYSO;
use myso::package;
use myso::vec_set::{Self, VecSet};
use std::string;
use std::string::String;
use std::u64;

// === Error Codes ===

/// Caller lacks the required permission for the operation.
const ENotPermitted: u64 = 0;
/// The group is archived (paused) and cannot be mutated.
const EGroupArchived: u64 = 1;
/// The provided `EncryptionHistory` does not belong to the given group.
const EEncryptionHistoryMismatch: u64 = 2;
/// `PermissionsAdmin` holders cannot use `leave()`. They should use
/// `permissioned_group::remove_member()` for their own address instead,
/// which has a best-effort guard against removing the last `PermissionsAdmin`
/// (see `ELastPermissionsAdmin` — note that this count includes actor-object admins).
const EPermissionsAdminCannotLeave: u64 = 3;
/// The `MessageLog` object does not belong to the given group.
const EMessageLogMismatch: u64 = 4;
/// Sender follows recipient on a new 1:1 DM; paid open is not required.
const EPaidNotRequiredForFollower: u64 = 5;
/// Escrow is below the recipient's configured minimum for stranger paid DMs.
const EBelowMinMessageCost: u64 = 6;
/// Transaction sender does not match the resolved agent actor address.
const EAgentSenderMismatch: u64 = 8;
/// Registered sub-agents must use `create_agent_group`, not human `create_group`.
const ERegisteredAgentCannotCreateGroup: u64 = 9;

const CONVERSATION_KIND_KEY: vector<u8> = b"conversation_kind";
const CONVERSATION_KIND_DM: vector<u8> = b"dm";

const AGENT_CHAT_KEY: vector<u8> = b"agent_chat";
const AGENT_CHAT_TRUE: vector<u8> = b"true";
const CREATOR_ACTOR_KEY: vector<u8> = b"creator_actor";
const CREATOR_PRINCIPAL_KEY: vector<u8> = b"creator_principal";
const CREATOR_SUB_AGENT_ID_KEY: vector<u8> = b"creator_sub_agent_id";
const CREATOR_IDENTITY_CLASS_KEY: vector<u8> = b"creator_identity_class";

// === Witnesses ===

/// One-Time Witness for claiming Publisher.
public struct MESSAGING() has drop;

/// Package witness for `PermissionedGroup<Messaging>`.
public struct Messaging() has drop;

// === Permission Witnesses ===

/// Permission to send messages to the group.
/// Separate from `MessagingReader` to enable mute functionality.
public struct MessagingSender() has drop;

/// Permission to read/decrypt messages from the group.
/// Separate from `MessagingSender` to enable read-only or write-only access.
public struct MessagingReader() has drop;

/// Permission to delete messages in the group.
public struct MessagingDeleter() has drop;

/// Permission to edit messages in the group.
public struct MessagingEditor() has drop;

/// Permission to set or clear this group's handle in the package [`GroupHandleRegistry`].
public struct GroupHandleAdmin() has drop;

/// Permission to edit group metadata (name, data).
public struct MetadataAdmin() has drop;

// === Structs ===

/// Shared object used as namespace for deriving group and encryption history addresses.
/// One per package deployment.
public struct MessagingNamespace has key {
    id: UID,
}

/// Emitted when a sub-agent creates a messaging group via [`create_agent_group`].
/// Indexed by the messaging-stack relayer (not the social indexer) for conversation listing.
public struct AgentGroupCreated has copy, drop {
    group_id: ID,
    creator_actor: address,
    creator_principal: address,
    creator_sub_agent_id: Option<ID>,
    creator_identity_class: u64,
    organization_id: Option<ID>,
    group_name: String,
    group_uuid: String,
    created_at: u64,
}

fun init(otw: MESSAGING, ctx: &mut TxContext) {
    package::claim_and_keep(otw, ctx);

    let mut namespace = MessagingNamespace {
        id: object::new(ctx),
    };

    let group_leaver = group_leaver::new(&mut namespace.id);
    let group_manager = group_manager::new(&mut namespace.id);
    let group_handle_registry = group_handle_registry::new(&mut namespace.id, ctx);
    let paid_messaging_registry = paid_messaging_policy::new(&mut namespace.id, ctx);
    transfer::share_object(namespace);
    group_leaver.share();
    group_manager.share();
    group_handle_registry.share();
    paid_messaging_registry.share();
    version::share_initial(ctx);
}

// === Public Functions ===

/// Creates a new messaging group with encryption.
/// The transaction sender (`ctx.sender()`) automatically becomes the creator with all permissions.
///
/// # Parameters
/// - `version`: Reference to the Version shared object
/// - `namespace`: Mutable reference to the MessagingNamespace
/// - `group_manager`: Reference to the shared GroupManager actor
/// - `name`: Human-readable group name
/// - `uuid`: Client-provided UUID for deterministic address derivation
/// - `initial_encrypted_dek`: Initial MyData-encrypted DEK bytes
/// - `initial_members`: Addresses to grant `MessagingReader` permission (should not include
/// creator)
/// - `ctx`: Transaction context
///
/// # Returns
/// Tuple of `(PermissionedGroup<Messaging>, EncryptionHistory, MessageLog)`.
///
/// # Note
/// If `initial_members` contains the creator's address, it is silently skipped (no abort).
/// This handles the common case where the creator might be mistakenly included in the initial
/// members list.
///
/// # Aborts
/// - `EInvalidVersion` (from `version`): if package version doesn't match
/// - If the UUID has already been used (duplicate derivation)
public fun create_group(
    version: &Version,
    namespace: &mut MessagingNamespace,
    group_manager: &GroupManager,
    block_list: &BlockListRegistry,
    creator_memory_account: &MemoryAccount,
    name: String,
    uuid: String,
    initial_encrypted_dek: vector<u8>,
    initial_members: VecSet<address>,
    ctx: &mut TxContext,
): (PermissionedGroup<Messaging>, EncryptionHistory, MessageLog) {
    assert_human_group_creator(creator_memory_account, ctx);
    create_group_inner(
        version,
        namespace,
        group_manager,
        block_list,
        name,
        uuid,
        initial_encrypted_dek,
        initial_members,
        ctx,
    )
}

/// Human-only group creation without principal ownership check. Test-only bypass for
/// legacy unit tests that do not set up a [`MemoryAccount`].
#[test_only]
public fun create_group_unchecked(
    version: &Version,
    namespace: &mut MessagingNamespace,
    group_manager: &GroupManager,
    block_list: &BlockListRegistry,
    name: String,
    uuid: String,
    initial_encrypted_dek: vector<u8>,
    initial_members: VecSet<address>,
    ctx: &mut TxContext,
): (PermissionedGroup<Messaging>, EncryptionHistory, MessageLog) {
    create_group_inner(
        version,
        namespace,
        group_manager,
        block_list,
        name,
        uuid,
        initial_encrypted_dek,
        initial_members,
        ctx,
    )
}

fun create_group_inner(
    version: &Version,
    namespace: &mut MessagingNamespace,
    group_manager: &GroupManager,
    block_list: &BlockListRegistry,
    name: String,
    uuid: String,
    initial_encrypted_dek: vector<u8>,
    initial_members: VecSet<address>,
    ctx: &mut TxContext,
): (PermissionedGroup<Messaging>, EncryptionHistory, MessageLog) {
    version.validate_version();
    let creator = ctx.sender();
    assert_peers_not_blocked(block_list, creator, &initial_members);

    let mut group: PermissionedGroup<Messaging> = permissioned_group::new_derived<
        Messaging,
        encryption_history::PermissionedGroupTag,
    >(
        Messaging(),
        &mut namespace.id,
        encryption_history::permissions_group_tag(uuid),
        ctx,
    );

    grant_all_messaging_permissions(&mut group, creator, ctx);

    // Grant PermissionsAdmin to the GroupLeaver actor so it can remove members on behalf of
    // callers.
    // The address is derived deterministically from the namespace — no need to pass the object.
    let group_leaver_address = derived_object::derive_address(
        object::id(namespace),
        group_leaver::derivation_key(),
    );
    group.grant_permission<Messaging, PermissionsAdmin>(group_leaver_address, ctx);

    // Grant ObjectAdmin to the GroupManager actor so it can access the group UID
    // for metadata management (dynamic field on the group UID).
    group.grant_permission<Messaging, ObjectAdmin>(
        object::id(group_manager).to_address(),
        ctx,
    );

    // Attach Metadata via GroupManager
    let m = metadata::new(name, uuid, creator);
    group_manager::attach_metadata<Messaging>(group_manager, &mut group, m);

    if (count_non_creator_peers(&initial_members, creator) == 1) {
        let m = group_manager::borrow_metadata_mut<Messaging>(group_manager, &mut group);
        m.insert_data(
            string::utf8(CONVERSATION_KIND_KEY),
            string::utf8(CONVERSATION_KIND_DM),
        );
    };

    // Grant MessagingReader permission to initial members (skip creator)
    initial_members.into_keys().do!(|member| {
        if (member != creator) {
            group.grant_permission<Messaging, MessagingReader>(member, ctx);
        };
    });

    let encryption_history = encryption_history::new(
        &mut namespace.id,
        uuid,
        object::id(&group),
        initial_encrypted_dek,
        ctx,
    );

    let message_log = message_log::new(&mut namespace.id, uuid, object::id(&group), ctx);

    (group, encryption_history, message_log)
}

/// Creates a new messaging group and shares both objects.
///
/// # Parameters
/// - `version`: Reference to the Version shared object
/// - `namespace`: Mutable reference to the MessagingNamespace
/// - `group_manager`: Reference to the shared GroupManager actor
/// - `name`: Human-readable group name
/// - `uuid`: Client-provided UUID for deterministic address derivation
/// - `initial_encrypted_dek`: Initial MyData-encrypted DEK bytes
/// - `initial_members`: Set of addresses to grant `MessagingReader` permission
/// - `ctx`: Transaction context
///
/// # Note
/// See `create_group` for details on creator permissions and initial member handling.
#[allow(lint(share_owned))]
entry fun create_and_share_group(
    version: &Version,
    namespace: &mut MessagingNamespace,
    group_manager: &GroupManager,
    block_list: &BlockListRegistry,
    creator_memory_account: &MemoryAccount,
    name: String,
    uuid: String,
    initial_encrypted_dek: vector<u8>,
    initial_members: vector<address>,
    ctx: &mut TxContext,
) {
    let (group, encryption_history, message_log) = create_group(
        version,
        namespace,
        group_manager,
        block_list,
        creator_memory_account,
        name,
        uuid,
        initial_encrypted_dek,
        vec_set::from_keys(initial_members),
        ctx,
    );
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    transfer::public_share_object(message_log);
}

/// Creates a messaging group on behalf of a sub-agent with principal oversight.
///
/// The transaction sender must be the sub-agent `derived_address` with
/// `CAP_MESSAGE_SEND`. The agent receives messaging permissions but not
/// `PermissionsAdmin`. The human `principal_owner` receives `MessagingReader`
/// and `PermissionsAdmin`.
///
/// For cross-principal agent peers in `initial_members`, pass their
/// [`MemoryAccount`] as `cross_principal_peer_account`. When all peers are
/// humans or agents under the same principal, pass the creator account again.
public fun create_agent_group(
    version: &Version,
    namespace: &mut MessagingNamespace,
    group_manager: &GroupManager,
    group_leaver: &GroupLeaver,
    block_list: &BlockListRegistry,
    platform: &Platform,
    creator_memory_account: &MemoryAccount,
    cross_principal_peer_account: &MemoryAccount,
    name: String,
    uuid: String,
    initial_encrypted_dek: vector<u8>,
    initial_members: VecSet<address>,
    clock: &Clock,
    ctx: &mut TxContext,
): (PermissionedGroup<Messaging>, EncryptionHistory, MessageLog) {
    version.validate_version();
    let acting = resolve_messaging_actor(
        creator_memory_account,
        platform,
        block_list,
        memory::cap_message_send(),
        0,
        clock,
        ctx,
    );
    let actor_address = memory::acting_actor_address(&acting);
    let principal_owner = memory::acting_principal_owner(&acting);
    assert!(actor_address == ctx.sender(), EAgentSenderMismatch);

    assert_agent_peers_not_blocked(
        block_list,
        &acting,
        &initial_members,
        actor_address,
    );

    let mut group: PermissionedGroup<Messaging> = permissioned_group::new_derived<
        Messaging,
        encryption_history::PermissionedGroupTag,
    >(
        Messaging(),
        &mut namespace.id,
        encryption_history::permissions_group_tag(uuid),
        ctx,
    );

    // `new_derived` grants PermissionsAdmin to the agent creator. Grant GroupLeaver
    // admin first so it can revoke the agent's admin caps, then grant the principal.
    let group_leaver_address = derived_object::derive_address(
        object::id(namespace),
        group_leaver::derivation_key(),
    );
    group.grant_permission<Messaging, PermissionsAdmin>(group_leaver_address, ctx);
    grant_agent_messaging_permissions(&mut group, actor_address, ctx);
    grant_principal_oversight(&mut group, principal_owner, ctx);
    group.grant_permission<Messaging, ObjectAdmin>(
        object::id(group_manager).to_address(),
        ctx,
    );

    let m = metadata::new(name, uuid, actor_address);
    group_manager::attach_metadata<Messaging>(group_manager, &mut group, m);
    attach_agent_creator_metadata(group_manager, &mut group, &acting);

    if (count_non_creator_peers(&initial_members, actor_address) == 1) {
        let m = group_manager::borrow_metadata_mut<Messaging>(group_manager, &mut group);
        m.insert_data(
            string::utf8(CONVERSATION_KIND_KEY),
            string::utf8(CONVERSATION_KIND_DM),
        );
    };

    grant_agent_initial_members(
        &mut group,
        creator_memory_account,
        cross_principal_peer_account,
        &initial_members,
        actor_address,
        ctx,
    );

    group_leaver::revoke_permissions_admin<Messaging>(group_leaver, &mut group, actor_address);
    group_leaver::revoke_extension_permissions_admin<Messaging>(group_leaver, &mut group, actor_address);

    let encryption_history = encryption_history::new(
        &mut namespace.id,
        uuid,
        object::id(&group),
        initial_encrypted_dek,
        ctx,
    );

    let message_log = message_log::new(&mut namespace.id, uuid, object::id(&group), ctx);

    event::emit(AgentGroupCreated {
        group_id: object::id(&group),
        creator_actor: actor_address,
        creator_principal: principal_owner,
        creator_sub_agent_id: memory::acting_sub_agent_id(&acting),
        creator_identity_class: memory::acting_identity_class(&acting) as u64,
        organization_id: memory::acting_organization_id(&acting),
        group_name: name,
        group_uuid: uuid,
        created_at: clock::timestamp_ms(clock),
    });

    (group, encryption_history, message_log)
}

/// Entry point: create and share an agent-associated messaging group.
#[allow(lint(share_owned))]
entry fun create_agent_and_share_group(
    version: &Version,
    namespace: &mut MessagingNamespace,
    group_manager: &GroupManager,
    group_leaver: &GroupLeaver,
    block_list: &BlockListRegistry,
    platform: &Platform,
    creator_memory_account: &MemoryAccount,
    cross_principal_peer_account: &MemoryAccount,
    name: String,
    uuid: String,
    initial_encrypted_dek: vector<u8>,
    initial_members: vector<address>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let (group, encryption_history, message_log) = create_agent_group(
        version,
        namespace,
        group_manager,
        group_leaver,
        block_list,
        platform,
        creator_memory_account,
        cross_principal_peer_account,
        name,
        uuid,
        initial_encrypted_dek,
        vec_set::from_keys(initial_members),
        clock,
        ctx,
    );
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    transfer::public_share_object(message_log);
}

/// Rotates the encryption key for a group.
///
/// # Parameters
/// - `encryption_history`: Mutable reference to the group's EncryptionHistory
/// - `group`: Reference to the PermissionedGroup<Messaging>
/// - `new_encrypted_dek`: New MyData-encrypted DEK bytes
/// - `ctx`: Transaction context
///
/// # Aborts
/// - `EInvalidVersion` (from `version`): if package version doesn't match
/// - `ENotPermitted`: if caller doesn't have `EncryptionKeyRotator` permission
public fun rotate_encryption_key(
    version: &Version,
    encryption_history: &mut EncryptionHistory,
    group: &PermissionedGroup<Messaging>,
    new_encrypted_dek: vector<u8>,
    ctx: &TxContext,
) {
    version.validate_version();
    assert!(!group.is_paused(), EGroupArchived);
    assert!(encryption_history.group_id() == object::id(group), EEncryptionHistoryMismatch);
    assert!(group.has_permission<Messaging, EncryptionKeyRotator>(ctx.sender()), ENotPermitted);
    encryption_history.rotate_key(new_encrypted_dek);
}

/// Removes the caller from a messaging group.
/// The `GroupLeaver` actor holds `PermissionsAdmin` on all groups and calls
/// `object_remove_member` on behalf of the caller.
///
/// `PermissionsAdmin` holders cannot use this function. Since they already have
/// `PermissionsAdmin`, they can call `permissioned_group::remove_member()` for
/// their own address instead. Alternatively, they can first revoke their own
/// `PermissionsAdmin` and then call `leave()`.
///
/// **Why**: `leave()` is a self-service action via the `GroupLeaver` actor object.
/// Since `permissions_admin_count` includes both human and actor-object admins,
/// there is no reliable way to determine whether removing the caller would leave
/// the group without a human admin. Blocking `PermissionsAdmin` holders from
/// `leave()` makes this a deliberate admin decision rather than a casual action.
///
/// **Limitation**: Note that `permissions_admin_count` is a best-effort invariant.
/// Even via `remove_member()`, a group could end up with only actor-object admins
/// if the caller removes themselves when they are the last human admin. The count
/// cannot distinguish human from actor-object holders.
///
/// # Parameters
/// - `group_leaver`: Reference to the shared `GroupLeaver` object
/// - `group`: Mutable reference to the `PermissionedGroup<Messaging>`
/// - `ctx`: Transaction context
///
/// # Aborts
/// - `EPermissionsAdminCannotLeave`: if the caller holds `PermissionsAdmin`
/// - `EMemberNotFound` (from `permissioned_group`): if the caller is not a member
public fun leave(
    group_leaver: &GroupLeaver,
    group: &mut PermissionedGroup<Messaging>,
    ctx: &TxContext,
) {
    assert!(
        !group.has_permission<Messaging, PermissionsAdmin>(ctx.sender()),
        EPermissionsAdminCannotLeave,
    );
    group_leaver::leave<Messaging>(group_leaver, group, ctx);
}

// === Archive Functions ===

/// Permanently archives a messaging group.
///
/// Pauses the group and burns the `UnpauseCap`, making it impossible to unpause.
/// After this call, `is_paused()` returns `true` and all mutations are blocked.
///
/// The caller must have `PermissionsAdmin` permission (enforced by `pause()`).
///
/// # Aborts
/// - `ENotPermitted` (from `pause`): if caller doesn't have `PermissionsAdmin`
/// - `EAlreadyPaused` (from `pause`): if the group is already paused
///
/// # Note
/// Alternative to burning: `transfer::public_freeze_object(cap)` makes the cap immutable
/// and un-passable by value, also preventing unpause without destroying the object.
entry fun archive_group(
    version: &Version,
    group: &mut PermissionedGroup<Messaging>,
    ctx: &mut TxContext,
) {
    version.validate_version();
    let cap = group.pause<Messaging>(ctx);
    cap.burn();
}

// === Group handle registry (separate from profile usernames) ===

/// Registers or replaces the canonical handle for this group in the shared [`GroupHandleRegistry`].
///
/// The caller must have `GroupHandleAdmin`. See `group_handle_registry::set_handle` for handle rules.
///
/// # Aborts
/// - `ENotPermitted`: if caller doesn't have `GroupHandleAdmin`
/// - `EGroupArchived`: if the group is paused
/// - `group_handle_registry::EHandleTaken` / `EInvalidHandle`: from the registry
public fun set_group_handle(
    version: &Version,
    registry: &mut GroupHandleRegistry,
    group: &mut PermissionedGroup<Messaging>,
    handle: String,
    ctx: &TxContext,
) {
    version.validate_version();
    assert_group_not_archived(group);
    assert!(group.has_permission<Messaging, GroupHandleAdmin>(ctx.sender()), ENotPermitted);
    group_handle_registry::set_handle(registry, object::id(group), handle);
}

/// Removes this group's handle from the registry, if any.
///
/// # Aborts
/// - `ENotPermitted`: if caller doesn't have `GroupHandleAdmin`
/// - `EGroupArchived`: if the group is paused
public fun clear_group_handle(
    version: &Version,
    registry: &mut GroupHandleRegistry,
    group: &mut PermissionedGroup<Messaging>,
    ctx: &TxContext,
) {
    version.validate_version();
    assert_group_not_archived(group);
    assert!(group.has_permission<Messaging, GroupHandleAdmin>(ctx.sender()), ENotPermitted);
    group_handle_registry::clear_handle(registry, object::id(group));
}

/// Read-only: resolve a handle to a group object ID. Does not require `GroupHandleAdmin`.
public fun lookup_group_by_handle(registry: &GroupHandleRegistry, handle: String): Option<ID> {
    group_handle_registry::lookup_group_by_handle(registry, handle)
}

// === Metadata Functions ===

/// Sets the group name.
/// Caller must have `MetadataAdmin` permission.
///
/// # Aborts
/// - `ENotPermitted`: if caller doesn't have `MetadataAdmin`
/// - `ENameTooLong` (from `metadata`): if name exceeds limit
public fun set_group_name(
    group_manager: &GroupManager,
    group: &mut PermissionedGroup<Messaging>,
    name: String,
    ctx: &TxContext,
) {
    assert!(group.has_permission<Messaging, MetadataAdmin>(ctx.sender()), ENotPermitted);
    let m = group_manager::borrow_metadata_mut<Messaging>(group_manager, group);
    m.set_name(name);
}

/// Inserts a key-value pair into the group's metadata data map.
/// Caller must have `MetadataAdmin` permission.
///
/// # Aborts
/// - `ENotPermitted`: if caller doesn't have `MetadataAdmin`
/// - `EDataKeyTooLong` (from `metadata`): if key exceeds limit
/// - `EDataValueTooLong` (from `metadata`): if value exceeds limit
public fun insert_group_data(
    group_manager: &GroupManager,
    group: &mut PermissionedGroup<Messaging>,
    key: String,
    value: String,
    ctx: &TxContext,
) {
    assert!(group.has_permission<Messaging, MetadataAdmin>(ctx.sender()), ENotPermitted);
    let m = group_manager::borrow_metadata_mut<Messaging>(group_manager, group);
    m.insert_data(key, value);
}

/// Removes a key-value pair from the group's metadata data map.
/// Caller must have `MetadataAdmin` permission.
///
/// # Returns
/// The removed (key, value) tuple.
///
/// # Aborts
/// - `ENotPermitted`: if caller doesn't have `MetadataAdmin`
public fun remove_group_data(
    group_manager: &GroupManager,
    group: &mut PermissionedGroup<Messaging>,
    key: &String,
    ctx: &TxContext,
): (String, String) {
    assert!(group.has_permission<Messaging, MetadataAdmin>(ctx.sender()), ENotPermitted);
    let m = group_manager::borrow_metadata_mut<Messaging>(group_manager, group);
    m.remove_data(key)
}

// === Message log (paid MYSO escrow only) ===

fun assert_message_log_matches_group(log: &MessageLog, group: &PermissionedGroup<Messaging>) {
    assert!(message_log::group_id(log) == object::id(group), EMessageLogMismatch);
}

fun assert_group_not_archived(group: &PermissionedGroup<Messaging>) {
    assert!(!group.is_paused(), EGroupArchived);
}

/// Escrow `escrow_amount` from `payment` for a paid message. Requires `MessagingSender`.
/// Excess coin returns to the sender.
public fun send_paid_message_digest(
    version: &Version,
    group: &PermissionedGroup<Messaging>,
    log: &mut MessageLog,
    paid_registry: &PaidMessagingRegistry,
    social_graph: &SocialGraph,
    block_list: &BlockListRegistry,
    group_manager: &GroupManager,
    recipient: address,
    payment: Coin<MYSO>,
    escrow_amount: u64,
    dedupe_key: vector<u8>,
    nonce: u128,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    version.validate_version();
    assert_group_not_archived(group);
    assert_message_log_matches_group(log, group);
    assert!(group.has_permission<Messaging, MessagingSender>(ctx.sender()), ENotPermitted);
    let sender = ctx.sender();
    assert_paid_open_allowed(
        paid_registry,
        social_graph,
        block_list,
        group_manager,
        group,
        log,
        sender,
        sender,
        recipient,
        escrow_amount,
    );
    message_log::send_paid_message(
        log,
        sender,
        recipient,
        payment,
        escrow_amount,
        dedupe_key,
        nonce,
        clock,
        ctx,
    );
}

/// Agent variant of [`send_paid_message_digest`]. Resolves the sub-agent actor and
/// evaluates paid-DM / social-graph rules against the human `principal_owner`.
public fun send_agent_paid_message_digest(
    version: &Version,
    group: &PermissionedGroup<Messaging>,
    log: &mut MessageLog,
    paid_registry: &PaidMessagingRegistry,
    social_graph: &SocialGraph,
    block_list: &BlockListRegistry,
    group_manager: &GroupManager,
    platform: &Platform,
    memory_account: &MemoryAccount,
    recipient: address,
    payment: Coin<MYSO>,
    escrow_amount: u64,
    dedupe_key: vector<u8>,
    nonce: u128,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    version.validate_version();
    assert_group_not_archived(group);
    assert_message_log_matches_group(log, group);
    let acting = resolve_messaging_actor(
        memory_account,
        platform,
        block_list,
        memory::cap_message_send(),
        coin::value(&payment),
        clock,
        ctx,
    );
    let actor_address = memory::acting_actor_address(&acting);
    let principal_owner = memory::acting_principal_owner(&acting);
    assert!(actor_address == ctx.sender(), EAgentSenderMismatch);
    assert!(group.has_permission<Messaging, MessagingSender>(actor_address), ENotPermitted);
    assert_paid_open_allowed(
        paid_registry,
        social_graph,
        block_list,
        group_manager,
        group,
        log,
        actor_address,
        principal_owner,
        recipient,
        escrow_amount,
    );
    message_log::send_paid_message(
        log,
        actor_address,
        recipient,
        payment,
        escrow_amount,
        dedupe_key,
        nonce,
        clock,
        ctx,
    );
}

/// Reply to a paid message and take full escrow as coin. Caller may split fees (e.g. via
/// [`reply_to_paid_message_claim_settled`]) or use this entry for custom routing.
public fun reply_to_paid_message_claim_coin(
    version: &Version,
    group: &PermissionedGroup<Messaging>,
    log: &mut MessageLog,
    block_list: &BlockListRegistry,
    paid_msg_seq: u64,
    char_count: u32,
    dedupe_key: vector<u8>,
    nonce: u128,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<MYSO> {
    version.validate_version();
    assert_group_not_archived(group);
    assert_message_log_matches_group(log, group);
    assert!(group.has_permission<Messaging, MessagingSender>(ctx.sender()), ENotPermitted);
    assert_paid_parties_not_blocked(block_list, ctx.sender(), log, paid_msg_seq);
    message_log::reply_to_paid_message_claim_coin(
        log,
        ctx.sender(),
        paid_msg_seq,
        char_count,
        dedupe_key,
        nonce,
        clock,
        ctx,
    )
}

/// Reply and settle: same validation as [`reply_to_paid_message_claim_coin`], then split escrow per
/// paid-message BPS to `platform_fee_recipient` and `ecosystem_fee_recipient` (typically addresses
/// matching `Platform` treasury policy and `EcosystemTreasury`), with net to the paid-message recipient.
public fun reply_to_paid_message_claim_settled(
    version: &Version,
    group: &PermissionedGroup<Messaging>,
    log: &mut MessageLog,
    block_list: &BlockListRegistry,
    paid_msg_seq: u64,
    char_count: u32,
    dedupe_key: vector<u8>,
    nonce: u128,
    clock: &Clock,
    platform_fee_recipient: address,
    ecosystem_fee_recipient: address,
    ctx: &mut TxContext,
) {
    version.validate_version();
    assert_group_not_archived(group);
    assert_message_log_matches_group(log, group);
    assert!(group.has_permission<Messaging, MessagingSender>(ctx.sender()), ENotPermitted);
    assert_paid_parties_not_blocked(block_list, ctx.sender(), log, paid_msg_seq);
    message_log::reply_to_paid_message_claim_settled(
        log,
        ctx.sender(),
        paid_msg_seq,
        char_count,
        dedupe_key,
        nonce,
        clock,
        platform_fee_recipient,
        ecosystem_fee_recipient,
        ctx,
    );
}

/// Refund expired paid escrow to the payer. Requires `MessagingSender` (payer must be a member).
public fun refund_paid_escrow(
    version: &Version,
    group: &PermissionedGroup<Messaging>,
    log: &mut MessageLog,
    block_list: &BlockListRegistry,
    paid_msg_seq: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    version.validate_version();
    assert_group_not_archived(group);
    assert_message_log_matches_group(log, group);
    assert!(group.has_permission<Messaging, MessagingSender>(ctx.sender()), ENotPermitted);
    let (payer, recipient) = message_log::paid_message_parties(log, paid_msg_seq);
    block_list::assert_not_blocked(block_list, payer, recipient);
    message_log::refund_paid_message(log, ctx.sender(), paid_msg_seq, clock, ctx);
}

/// Grants all messaging permissions to a member.
/// `MessagingDeleter`, `EncryptionKeyRotator`, `GroupHandleAdmin`, `MetadataAdmin`.
fun grant_all_messaging_permissions(
    group: &mut PermissionedGroup<Messaging>,
    member: address,
    ctx: &TxContext,
) {
    group.grant_permission<Messaging, MessagingSender>(member, ctx);
    group.grant_permission<Messaging, MessagingReader>(member, ctx);
    group.grant_permission<Messaging, MessagingEditor>(member, ctx);
    group.grant_permission<Messaging, MessagingDeleter>(member, ctx);
    group.grant_permission<Messaging, EncryptionKeyRotator>(member, ctx);
    group.grant_permission<Messaging, GroupHandleAdmin>(member, ctx);
    group.grant_permission<Messaging, MetadataAdmin>(member, ctx);
}

/// Messaging permissions for sub-agent creators and agent peers (no admin caps).
fun grant_agent_messaging_permissions(
    group: &mut PermissionedGroup<Messaging>,
    member: address,
    ctx: &TxContext,
) {
    group.grant_permission<Messaging, MessagingSender>(member, ctx);
    group.grant_permission<Messaging, MessagingReader>(member, ctx);
}

/// Principal human oversight: read-only membership plus group admin control.
fun grant_principal_oversight(
    group: &mut PermissionedGroup<Messaging>,
    principal: address,
    ctx: &TxContext,
) {
    group.grant_permission<Messaging, MessagingReader>(principal, ctx);
    group.grant_permission<Messaging, PermissionsAdmin>(principal, ctx);
}

/// Default permissions for human peers joining an agent-created group.
fun grant_human_peer_permissions(
    group: &mut PermissionedGroup<Messaging>,
    member: address,
    ctx: &TxContext,
) {
    group.grant_permission<Messaging, MessagingSender>(member, ctx);
    group.grant_permission<Messaging, MessagingReader>(member, ctx);
}

fun assert_human_group_creator(memory_account: &MemoryAccount, ctx: &TxContext) {
    let sender = ctx.sender();
    assert!(sender == memory::owner(memory_account), ENotPermitted);
    assert!(
        !memory::is_registered_agent(memory_account, sender),
        ERegisteredAgentCannotCreateGroup,
    );
}

fun resolve_messaging_actor(
    memory_account: &MemoryAccount,
    platform: &Platform,
    block_list: &BlockListRegistry,
    required_cap: u64,
    spend_amount: u64,
    clock: &Clock,
    ctx: &TxContext,
): ActingContext {
    let platform_id = object::uid_to_address(platform::id(platform));
    let acting = memory::resolve_actor_with_cap(
        memory_account,
        required_cap,
        option::some(platform_id),
        spend_amount,
        clock,
        ctx,
    );
    memory::assert_direct_execution_allowed(memory_account, required_cap, ctx);
    let principal = memory::acting_principal_owner(&acting);
    assert!(memory::owner(memory_account) == principal, ENotPermitted);
    assert!(platform::has_joined_platform(platform, principal), ENotPermitted);
    assert!(
        !block_list::is_blocked(block_list, platform_id, principal),
        ENotPermitted,
    );
    acting
}

fun attach_agent_creator_metadata(
    group_manager: &GroupManager,
    group: &mut PermissionedGroup<Messaging>,
    acting: &ActingContext,
) {
    let m = group_manager::borrow_metadata_mut<Messaging>(group_manager, group);
    m.insert_data(string::utf8(AGENT_CHAT_KEY), string::utf8(AGENT_CHAT_TRUE));
    m.insert_data(
        string::utf8(CREATOR_ACTOR_KEY),
        address_to_metadata_string(memory::acting_actor_address(acting)),
    );
    m.insert_data(
        string::utf8(CREATOR_PRINCIPAL_KEY),
        address_to_metadata_string(memory::acting_principal_owner(acting)),
    );
    if (option::is_some(&memory::acting_sub_agent_id(acting))) {
        m.insert_data(
            string::utf8(CREATOR_SUB_AGENT_ID_KEY),
            id_to_metadata_string(*option::borrow(&memory::acting_sub_agent_id(acting))),
        );
    };
    m.insert_data(
        string::utf8(CREATOR_IDENTITY_CLASS_KEY),
        u64_to_metadata_string(memory::acting_identity_class(acting) as u64),
    );
}

fun grant_agent_initial_members(
    group: &mut PermissionedGroup<Messaging>,
    creator_account: &MemoryAccount,
    cross_principal_peer_account: &MemoryAccount,
    initial_members: &VecSet<address>,
    actor_address: address,
    ctx: &TxContext,
) {
    let keys = initial_members.keys();
    let len = vector::length(keys);
    let mut i = 0;
    while (i < len) {
        let member = *vector::borrow(keys, i);
        if (member != actor_address) {
            if (memory::is_registered_agent(creator_account, member)) {
                grant_agent_messaging_permissions(group, member, ctx);
            } else if (memory::is_registered_agent(cross_principal_peer_account, member)) {
                grant_agent_messaging_permissions(group, member, ctx);
                grant_principal_oversight(group, memory::owner(cross_principal_peer_account), ctx);
            } else {
                grant_human_peer_permissions(group, member, ctx);
            };
        };
        i = i + 1;
    };
}

fun assert_agent_peers_not_blocked(
    block_list: &BlockListRegistry,
    acting: &ActingContext,
    members: &VecSet<address>,
    actor_address: address,
) {
    let principal = memory::acting_principal_owner(acting);
    let keys = members.keys();
    let len = vector::length(keys);
    let mut i = 0;
    while (i < len) {
        let member = *vector::borrow(keys, i);
        if (member != actor_address) {
            block_list::assert_not_blocked(block_list, actor_address, member);
            block_list::assert_not_blocked(block_list, principal, member);
        };
        i = i + 1;
    };
}

fun address_to_metadata_string(addr: address): String {
    string::utf8(hex::encode(addr.to_bytes()))
}

fun id_to_metadata_string(id: ID): String {
    string::utf8(hex::encode(id.to_bytes()))
}

fun u64_to_metadata_string(value: u64): String {
    u64::to_string(value)
}

fun assert_peers_not_blocked(
    block_list: &BlockListRegistry,
    creator: address,
    members: &VecSet<address>,
) {
    let keys = members.keys();
    let len = vector::length(keys);
    let mut i = 0;
    while (i < len) {
        let member = *vector::borrow(keys, i);
        if (member != creator) {
            block_list::assert_not_blocked(block_list, creator, member);
        };
        i = i + 1;
    };
}

fun count_non_creator_peers(members: &VecSet<address>, creator: address): u64 {
    let keys = members.keys();
    let len = vector::length(keys);
    let mut i = 0;
    let mut count = 0;
    while (i < len) {
        let member = *vector::borrow(keys, i);
        if (member != creator) {
            count = count + 1;
        };
        i = i + 1;
    };
    count
}

fun is_direct_message_group(
    group_manager: &GroupManager,
    group: &PermissionedGroup<Messaging>,
): bool {
    let m = group_manager::borrow_metadata<Messaging>(group_manager, group);
    let key = string::utf8(CONVERSATION_KIND_KEY);
    let maybe_value = metadata::get_data_value(m, &key);
    if (option::is_some(&maybe_value)) {
        *option::borrow(&maybe_value) == string::utf8(CONVERSATION_KIND_DM)
    } else {
        false
    }
}

/// Paid-DM gate for new 1:1 conversations. `sender` is the transaction actor; `social_identity`
/// is the human whose follow graph and paid policy apply (sender for humans, principal for agents).
fun assert_paid_open_allowed(
    paid_registry: &PaidMessagingRegistry,
    social_graph: &SocialGraph,
    block_list: &BlockListRegistry,
    group_manager: &GroupManager,
    group: &PermissionedGroup<Messaging>,
    log: &MessageLog,
    sender: address,
    social_identity: address,
    recipient: address,
    escrow_amount: u64,
) {
    block_list::assert_not_blocked(block_list, sender, recipient);
    block_list::assert_not_blocked(block_list, social_identity, recipient);
    if (!is_direct_message_group(group_manager, group)) {
        return
    };
    if (message_log::next_seq(log) != 0) {
        return
    };
    if (social_graph::is_following(social_graph, social_identity, recipient)) {
        abort EPaidNotRequiredForFollower
    };
    let min_cost = paid_messaging_policy::requires_payment_from(paid_registry, recipient);
    if (option::is_none(&min_cost)) {
        return
    };
    assert!(
        escrow_amount >= *option::borrow(&min_cost),
        EBelowMinMessageCost,
    );
}

fun assert_paid_parties_not_blocked(
    block_list: &BlockListRegistry,
    caller: address,
    log: &MessageLog,
    paid_msg_seq: u64,
) {
    let (payer, recipient) = message_log::paid_message_parties(log, paid_msg_seq);
    if (caller == payer) {
        block_list::assert_not_blocked(block_list, caller, recipient);
    } else if (caller == recipient) {
        block_list::assert_not_blocked(block_list, caller, payer);
    } else {
        block_list::assert_not_blocked(block_list, caller, payer);
        block_list::assert_not_blocked(block_list, caller, recipient);
    };
}

// === Test Helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    let clock = clock::create_for_testing(ctx);
    init_for_testing_with_clock(&clock, ctx);
    clock::share_for_testing(clock);
}

#[test_only]
public fun init_for_testing_with_clock(clock: &Clock, ctx: &mut TxContext) {
    init(MESSAGING(), ctx);
    block_list::test_init(clock, ctx);
    social_graph::init_for_testing(clock, ctx);
}

#[test_only]
public fun is_dm_group_for_testing(
    group_manager: &GroupManager,
    group: &PermissionedGroup<Messaging>,
): bool {
    is_direct_message_group(group_manager, group)
}

#[test_only]
public fun get_otw_for_testing(): MESSAGING {
    MESSAGING()
}
