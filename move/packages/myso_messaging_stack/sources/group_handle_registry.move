/// On-chain registry mapping **canonical group handles** to `PermissionedGroup<Messaging>` object IDs.
///
/// This is intentionally separate from any **profile** `UsernameRegistry` (user usernames): the same
/// string may exist as both a user username and a group handle; clients use separate lookup APIs (`lookup_profile_by_username` vs `lookup_group_by_handle`).
module myso_messaging::group_handle_registry;

use myso::derived_object;
use myso::table::{Self, Table};
use std::string::{Self, String};

// === Error codes ===

const EInvalidHandle: u64 = 0;
const EHandleTaken: u64 = 1;

// === Derivation ===

const GROUP_HANDLE_REGISTRY_DERIVATION_KEY: vector<u8> = b"group_handle_registry";

// === Storage ===

public struct GroupHandleRegistry has key {
    id: UID,
    handle_to_group: Table<String, ID>,
    group_to_handle: Table<ID, String>,
}

// === Lifecycle (package) ===

public(package) fun new(namespace_uid: &mut UID, ctx: &mut TxContext): GroupHandleRegistry {
    GroupHandleRegistry {
        id: derived_object::claim(
            namespace_uid,
            GROUP_HANDLE_REGISTRY_DERIVATION_KEY.to_string(),
        ),
        handle_to_group: table::new(ctx),
        group_to_handle: table::new(ctx),
    }
}

public(package) fun share(self: GroupHandleRegistry) {
    transfer::share_object(self);
}

/// Matches [`GROUP_HANDLE_REGISTRY_DERIVATION_KEY`](group_handle_registry) in TS (`GROUP_HANDLE_REGISTRY_DERIVATION_KEY`).
public(package) fun derivation_key(): String {
    GROUP_HANDLE_REGISTRY_DERIVATION_KEY.to_string()
}

// === Canonical form (ASCII lowercase A–Z only; same spirit as reference profile) ===

fun to_lowercase_bytes(bytes: &vector<u8>): vector<u8> {
    let mut result = vector::empty<u8>();
    let len = vector::length(bytes);
    let mut i = 0;
    while (i < len) {
        let b = *vector::borrow(bytes, i);
        let out = if (b >= 65 && b <= 90) {
            b + 32
        } else {
            b
        };
        vector::push_back(&mut result, out);
        i = i + 1;
    };
    result
}

fun canonical_handle(s: &String): String {
    let lowered = to_lowercase_bytes(string::as_bytes(s));
    string::utf8(lowered)
}

fun duplicate_string(s: &String): String {
    let bytes = string::as_bytes(s);
    let len = vector::length(bytes);
    let mut v = vector::empty<u8>();
    let mut i = 0;
    while (i < len) {
        vector::push_back(&mut v, *vector::borrow(bytes, i));
        i = i + 1;
    };
    string::utf8(v)
}

fun is_valid_handle_chars(h: &String): bool {
    let bytes = string::as_bytes(h);
    let len = vector::length(bytes);
    let mut i = 0;
    while (i < len) {
        let b = *vector::borrow(bytes, i);
        let ok = (b >= 48 && b <= 57) || // 0-9
            (b >= 97 && b <= 122) || // a-z
            (b == 95);
        if (!ok) {
            return false
        };
        i = i + 1;
    };
    true
}

fun is_reserved(h: &String): bool {
    let bytes = string::as_bytes(h);
    is_bytes_eq(bytes, &b"admin")
        || is_bytes_eq(bytes, &b"root")
        || is_bytes_eq(bytes, &b"system")
        || is_bytes_eq(bytes, &b"myso")
        || is_bytes_eq(bytes, &b"support")
}

fun is_bytes_eq(lhs: &vector<u8>, rhs: &vector<u8>): bool {
    if (vector::length(lhs) != vector::length(rhs)) {
        return false
    };
    let len = vector::length(lhs);
    let mut i = 0;
    while (i < len) {
        if (*vector::borrow(lhs, i) != *vector::borrow(rhs, i)) {
            return false
        };
        i = i + 1;
    };
    true
}

fun validate_handle_string(handle: String): String {
    let h = canonical_handle(&handle);
    let len = string::length(&h);
    assert!(len >= 2 && len <= 50, EInvalidHandle);
    assert!(is_valid_handle_chars(&h), EInvalidHandle);
    assert!(!is_reserved(&h), EInvalidHandle);
    h
}

// === Mutations (package — messaging enforces `GroupHandleAdmin`) ===

public(package) fun set_handle(
    registry: &mut GroupHandleRegistry,
    group_id: ID,
    handle: String,
) {
    let h = validate_handle_string(handle);
    // Drop any existing mapping for this group.
    if (table::contains(&registry.group_to_handle, group_id)) {
        let old_h = table::remove(&mut registry.group_to_handle, group_id);
        table::remove(&mut registry.handle_to_group, old_h);
    };
    assert!(!table::contains(&registry.handle_to_group, h), EHandleTaken);
    let h_rev = duplicate_string(&h);
    table::add(&mut registry.handle_to_group, h, group_id);
    table::add(&mut registry.group_to_handle, group_id, h_rev);
}

public(package) fun clear_handle(registry: &mut GroupHandleRegistry, group_id: ID) {
    if (!table::contains(&registry.group_to_handle, group_id)) {
        return
    };
    let old_h = table::remove(&mut registry.group_to_handle, group_id);
    table::remove(&mut registry.handle_to_group, old_h);
}

// === Reads ===

/// Returns the group object ID for a handle, if registered. No version gate — safe for off-chain indexing.
public fun lookup_group_by_handle(registry: &GroupHandleRegistry, handle: String): Option<ID> {
    let h = canonical_handle(&handle);
    if (string::length(&h) < 2 || string::length(&h) > 50 || !is_valid_handle_chars(&h)) {
        return option::none()
    };
    if (is_reserved(&h)) {
        return option::none()
    };
    if (!table::contains(&registry.handle_to_group, h)) {
        return option::none()
    };
    option::some(*table::borrow(&registry.handle_to_group, h))
}
