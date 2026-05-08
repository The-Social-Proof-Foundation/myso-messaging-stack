/// Module: group_manager
///
/// Actor object that provides controlled `&mut UID` access to `PermissionedGroup<T>` objects.
///
/// `GroupManager` is a derived singleton object from `MessagingNamespace`.
/// It is granted `ObjectAdmin` on every group created via `messaging::create_group`,
/// and exposes functions for:
/// - Metadata dynamic field management
///
/// This module does NOT import `messaging.move` to avoid a circular dependency.
/// The generic functions are instantiated with the concrete `Messaging` type
/// at the call site in `messaging.move`.
///
/// All public entry points are in the `messaging` module.
module myso_messaging::group_manager;

use myso_messaging::metadata::{Self, Metadata};
use myso_groups::permissioned_group::PermissionedGroup;
use std::string::String;
use myso::derived_object;
use myso::dynamic_field;

// === Derivation Key ===

/// Fixed derivation key for the singleton `GroupManager` derived from `MessagingNamespace`.
const GROUP_MANAGER_DERIVATION_KEY: vector<u8> = b"group_manager";

// === Structs ===

/// Actor object that holds `ObjectAdmin` on all messaging groups.
/// The `id` field is intentionally private — no UID getter is exposed.
/// All operations go through the package-internal functions.
public struct GroupManager has key {
    id: UID,
}

// === Package Functions ===

/// Creates a new `GroupManager` derived from the namespace UID.
/// Called once during `messaging::init`.
///
/// # Parameters
/// - `namespace_uid`: Mutable reference to the `MessagingNamespace` UID
///
/// # Returns
/// A new `GroupManager` object with a deterministic address.
public(package) fun new(namespace_uid: &mut UID): GroupManager {
    GroupManager {
        id: derived_object::claim(namespace_uid, GROUP_MANAGER_DERIVATION_KEY.to_string()),
    }
}

/// Shares the `GroupManager` object on-chain.
/// Called once during `messaging::init` after creating the object.
public(package) fun share(self: GroupManager) {
    transfer::share_object(self);
}

/// Returns the fixed derivation key string.
/// Used by `messaging::create_group` to compute the `GroupManager`'s address via
/// `derived_object::derive_address` without holding the object.
///
/// # Returns
/// The string key used for address derivation.
public(package) fun derivation_key(): String {
    GROUP_MANAGER_DERIVATION_KEY.to_string()
}

// === Metadata Functions ===

/// Attaches Metadata as a dynamic field on the group.
/// Called during `messaging::create_group`.
public(package) fun attach_metadata<T: drop>(
    self: &GroupManager,
    group: &mut PermissionedGroup<T>,
    m: Metadata,
) {
    let uid = group.object_uid_mut<T>(&self.id);
    dynamic_field::add(uid, metadata::key(), m);
}

/// Removes and returns Metadata from the group.
/// Used when archiving/destroying a group to preserve metadata.
public(package) fun remove_metadata<T: drop>(
    self: &GroupManager,
    group: &mut PermissionedGroup<T>,
): Metadata {
    let uid = group.object_uid_mut<T>(&self.id);
    dynamic_field::remove(uid, metadata::key())
}

/// Returns an immutable reference to the group's Metadata.
public(package) fun borrow_metadata<T: drop>(
    self: &GroupManager,
    group: &PermissionedGroup<T>,
): &Metadata {
    let uid = group.object_uid<T>(&self.id);
    dynamic_field::borrow(uid, metadata::key())
}

/// Returns a mutable reference to the group's Metadata.
/// Used by messaging.move to expose field-level setters with permission checks.
public(package) fun borrow_metadata_mut<T: drop>(
    self: &GroupManager,
    group: &mut PermissionedGroup<T>,
): &mut Metadata {
    let uid = group.object_uid_mut<T>(&self.id);
    dynamic_field::borrow_mut(uid, metadata::key())
}
