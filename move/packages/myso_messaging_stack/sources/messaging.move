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
module myso_messaging::messaging;

use myso_messaging::encryption_history::{Self, EncryptionHistory, EncryptionKeyRotator};
use myso_messaging::group_leaver::{Self, GroupLeaver};
use myso_messaging::group_handle_registry::{Self, GroupHandleRegistry};
use myso_messaging::group_manager::{Self, GroupManager};
use myso_messaging::message_log::{Self, MessageLog};
use myso_messaging::metadata;
use myso_messaging::version::Version;
use myso_groups::permissioned_group::{
    Self,
    PermissionedGroup,
    PermissionsAdmin,
    ObjectAdmin
};
use std::string::String;
use myso::clock::Clock;
use myso::coin::Coin;
use myso::derived_object;
use myso::myso::MYSO;
use myso::package;
use myso::vec_set::{Self, VecSet};

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

fun init(otw: MESSAGING, ctx: &mut TxContext) {
    package::claim_and_keep(otw, ctx);

    let mut namespace = MessagingNamespace {
        id: object::new(ctx),
    };

    let group_leaver = group_leaver::new(&mut namespace.id);
    let group_manager = group_manager::new(&mut namespace.id);
    let group_handle_registry = group_handle_registry::new(&mut namespace.id, ctx);
    transfer::share_object(namespace);
    group_leaver.share();
    group_manager.share();
    group_handle_registry.share();
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
    name: String,
    uuid: String,
    initial_encrypted_dek: vector<u8>,
    initial_members: VecSet<address>,
    ctx: &mut TxContext,
): (PermissionedGroup<Messaging>, EncryptionHistory, MessageLog) {
    version.validate_version();
    let mut group: PermissionedGroup<Messaging> = permissioned_group::new_derived<
        Messaging,
        encryption_history::PermissionedGroupTag,
    >(
        Messaging(),
        &mut namespace.id,
        encryption_history::permissions_group_tag(uuid),
        ctx,
    );

    let creator = ctx.sender();
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
    let s = ctx.sender();
    message_log::send_paid_message(
        log,
        s,
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
    paid_msg_seq: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    version.validate_version();
    assert_group_not_archived(group);
    assert_message_log_matches_group(log, group);
    assert!(group.has_permission<Messaging, MessagingSender>(ctx.sender()), ENotPermitted);
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

// === Test Helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(MESSAGING(), ctx);
}

#[test_only]
public fun get_otw_for_testing(): MESSAGING {
    MESSAGING()
}
