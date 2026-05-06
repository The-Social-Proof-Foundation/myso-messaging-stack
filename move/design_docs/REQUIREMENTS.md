# Messaging SDK V2

In the revised Messaging SDK architecture, messaging capabilities are moved to an off-chain relayer service.
Sending, retrieving, archiving, and syncing messaging history are all handled off-chain.
An example implementation of such a service will be offered with and without Nautilus.

The smart contract handles Groups & fine-grained permissions, as well as integration with MyData.
A standalone generic Groups & Permissions smart contract is offered as a reusable library.

## Architecture Overview

### Package Structure

```
Layer 1: permissioned_groups
├── permissioned_group.move    # Generic permission system
├── permissions_table.move     # Storage for member → permissions mapping
├── unpause_cap.move           # Capability object for unpausing a paused group
└── display.move               # MySo Display standard for PermissionedGroup

Layer 2: messaging
├── messaging.move             # Messaging-specific wrapper and public entry points
├── encryption_history.move    # Key versioning with derived objects
├── mydata_policies.move         # Default mydata_approve implementations
├── group_leaver.move          # Singleton actor for self-service group leaving
├── group_manager.move         # Singleton actor for UID access (MySoNS, metadata)
├── metadata.move              # Metadata struct stored on each group
└── version.move               # Package version gating

Layer 3: example_app (third-party examples)
├── custom_mydata_policy.move    # Subscription-based access example
└── paid_join_rule.move        # Payment-gated membership example
```

### Key Design Decisions

1. **Generic Permissions System**: `PermissionedGroup<T>` is a top-level object (`key + store`) generic by type `T: drop`, specifying the application using the permissions. This allows the group to be passed alongside other objects for authentication without wrapping.

2. **Permission Hierarchy** (permissioned_groups package):
   - `PermissionsAdmin`: Can grant/revoke core permissions (PermissionsAdmin, ExtensionPermissionsAdmin, ObjectAdmin, GroupDeleter). Can remove members.
   - `ExtensionPermissionsAdmin`: Can grant/revoke extension permissions only (from third-party packages).
   - `ObjectAdmin`: Admin-tier permission granting raw `&UID` / `&mut UID` access to the group object. Only accessible via the actor-object pattern (`object_uid` / `object_uid_mut`).
   - `GroupDeleter`: Allows destroying the group via `delete()`. Caller receives `(PermissionsTable, u64, address)` and must clean up the returned table.
   - Extension permissions are application-specific (e.g., `MessagingReader`, `MessagingSender`).

3. **Membership Model**: Membership is implicit — having at least one permission makes an address a member. No separate membership concept.

4. **Object-based Authentication**: Objects (via their UID address) can be granted permissions alongside regular addresses, enabling the "actor pattern" for self-service operations.

5. **Discoverability**: Events are emitted for all permission changes, enabling discovery via indexers/GraphQL. `MessagingNamespace` serves as a shared object for deriving contract objects with deterministic addresses.

6. **MyData Integration** (messaging package):
   - `MessagingReader` permission is checked via MyData's `mydata_approve` functions (dry-run)
   - Other permissions (`MessagingSender`, `MessagingEditor`, `MessagingDeleter`) are verified client-side by fetching group permissions state
   - Only `EncryptionKeyRotator` operations are fully on-chain

7. **Pause and Unpause** (permissioned_groups package):
   - `PermissionsAdmin` can pause a group via `pause()`, which adds a `PausedMarker` dynamic field and returns an `UnpauseCap<T>`.
   - A paused group rejects all mutation calls (`assert_not_paused` guard on every mutating function).
   - Unpausing requires the `UnpauseCap` to be consumed via `unpause()`.
   - This is a generic mechanism available to any `PermissionedGroup<T>` — not specific to messaging.

8. **Archive** (messaging package):
   - `archive_group()` calls `pause()` and immediately burns the returned `UnpauseCap`, making the group permanently immutable.
   - Only `PermissionsAdmin` can archive a group (enforced by `pause()`).

9. **Version Gating** (messaging package only):
   - The `Version` shared object tracks the package version for the messaging contract.
   - `validate_version()` is called at the top of every entry function to enforce version compatibility.
   - Upgrade migrations bump the version via a `migrate` entry function (currently commented out pending the first upgrade).
   - The permissioned_groups package does not have version gating; it is expected to be upgraded directly.

10. **Singleton Actors** (messaging package):
    - `GroupLeaver`: Holds `PermissionsAdmin` on every group. Enables members to leave via `leave()` without needing to hold `PermissionsAdmin` themselves.
    - `GroupManager`: Holds `ObjectAdmin` on every group. Used for MySoNS reverse lookups and metadata management.
    - Both are derived singletons created once during `messaging::init` from `MessagingNamespace`.

11. **Metadata** (messaging package):
    - Every messaging group has a `Metadata` dynamic field (stored via `GroupManager`) containing `name`, `uuid`, `creator`, and an extensible `data: VecMap<String, String>`.
    - Mutable fields (`name`, `data`) require `MetadataAdmin` permission (a messaging extension permission).

## High Level Requirements

### Permission Management
- Keep track of member permissions per group
- Grant/revoke fine-grained permissions
- Check if a member has a specific permission
- Support both address-based and object-based permission holders

### Membership Operations
- Add members (by granting permissions)
- Remove members (by revoking all permissions, or via `remove_member`)
- Self-service leave via `GroupLeaver` actor (messaging package — no admin permission required from the member)

### Group Lifecycle
- **permissioned_groups**: Create groups (`new`, `new_derived`), pause/unpause, delete (via `GroupDeleter`)
- **messaging**: Create messaging groups (`create_group` / `create_and_share_group`), archive permanently (`archive_group`)

### Discoverability
- Events for all permission changes (grant, revoke, member add/remove)
- Events for group lifecycle changes (created, derived, deleted, paused, unpaused)
- Deterministic object addresses via derived objects from `MessagingNamespace`

### MyData Integration
- Default `mydata_approve` implementations for reader access (messaging package)
- Support for custom `mydata_approve` in third-party packages

### Metadata (messaging package)
- Human-readable group name with length validation
- Immutable fields: `uuid`, `creator`
- Mutable fields: `name`, `data` (key-value map), gated by `MetadataAdmin` permission

### MySoNS Integration (messaging package)
- Set/unset MySoNS reverse lookup on a group object via `GroupManager` + `MySoNsAdmin` permission

## Permissions

### Core Permissions (permissioned_groups package)

| Permission | Description |
|------------|-------------|
| `PermissionsAdmin` | Can grant/revoke core permissions (PermissionsAdmin, ExtensionPermissionsAdmin, ObjectAdmin, GroupDeleter). Can remove members. |
| `ExtensionPermissionsAdmin` | Can grant/revoke extension permissions (from other packages) |
| `ObjectAdmin` | Grants access to the group's UID (`&UID` and `&mut UID`), only via actor-object pattern |
| `GroupDeleter` | Allows destroying the group via `delete()` |

**Note on `PermissionsAdmin` scope**: `PermissionsAdmin` can only manage the four core permissions above. Extension permissions (from other packages) require `ExtensionPermissionsAdmin`.

### Messaging Permissions (messaging package)

| Permission | Description | Verification |
|------------|-------------|--------------|
| `MessagingReader` | Can decrypt messages | MyData dry-run |
| `MessagingSender` | Can send messages | Client-side |
| `MessagingEditor` | Can edit messages | Client-side |
| `MessagingDeleter` | Can delete messages | Client-side |
| `EncryptionKeyRotator` | Can rotate encryption keys | On-chain transaction |
| `MySoNsAdmin` | Can manage MySoNS reverse lookups | On-chain (gated in `messaging.move`) |
| `MetadataAdmin` | Can edit group metadata (name, data) | On-chain (gated in `messaging.move`) |

**Note**: Only `MessagingReader` is verified via MyData (dry-run, not a real transaction). Other messaging permissions are checked client-side by fetching the group's permission state, avoiding frequent transactions. Only key rotation and metadata/MySoNS changes require actual on-chain transactions.

## Customization

### Actor Pattern for Self-Service Operations

Third-party contracts can implement custom join/access rules using the "actor pattern":

1. **Define an actor object** (e.g., `PaidJoinRule`) that contains all relevant configuration (fee amount, associated group ID, accumulated balance, etc.)
2. **Grant the actor's address** `ExtensionPermissionsAdmin` permission on the group
3. **Users interact with the actor**, which grants them permissions via `object_grant_permission`
4. The actor's UID is passed to `object_grant_permission`, which verifies the actor has `ExtensionPermissionsAdmin` before granting the requested permission to the transaction sender

Example: `paid_join_rule.move` demonstrates payment-gated membership where:
- `PaidJoinRule<Token>` stores: group_id, fee amount, accumulated balance
- Users call `join()` with payment, and the rule grants them `MessagingReader` permission
- Members with `FundsManager` permission can withdraw accumulated fees

### Custom MyData Policies

Third-party contracts can implement custom `mydata_approve` functions for advanced access control:

- Use the standard identity bytes format `[group_id (32 bytes)][key_version (8 bytes LE u64)]` — the same format as the default policy
- Call `messaging::mydata_policies::validate_identity()` to enforce the standard format (no duplication)
- Add custom access checks on top (subscription validity, token ownership, etc.)
- Use their own package ID for MyData encryption (so the key server calls their `mydata_approve`)

Example: `custom_mydata_policy.move` demonstrates subscription-based access with TTL expiry.

## MyData Identity Bytes Format

### Standard identity bytes (enforced across all mydata_approve implementations)

Identity bytes always follow a single fixed format:

```
[group_id (32 bytes)][key_version (8 bytes, LE u64)]
Total: 40 bytes
```

- `group_id`: The `PermissionedGroup<Messaging>` object ID
- `key_version`: The encryption key version, enabling support for key rotation (decryption of historical messages uses the version in effect at the time of encryption)

This format is validated by `messaging::mydata_policies::validate_identity()`, which is called by all `mydata_approve` implementations — both the default one in the messaging package and any custom ones in third-party packages.

### Default mydata_approve (messaging package)

- **Package ID used for encryption**: messaging package
- **Access check**: caller must have `MessagingReader` permission
- **Use case**: Standard group member access

### Custom mydata_approve (third-party package)

- **Package ID used for encryption**: third-party package ID
- **Identity bytes**: same standard format — `[group_id (32 bytes)][key_version (8 bytes LE u64)]`
- **Access check**: defined by the third-party contract (e.g. subscription validity, token ownership)
- **Validation**: must call `messaging::mydata_policies::validate_identity()` to enforce the standard format
- **Use case**: Subscription-based access, token-gating, time-limited access

## Smart Contract Modules

### Layer 1: permissioned_groups

Generic reusable library for permission management.

**permissioned_group.move**:
- `PermissionedGroup<T>` struct (`key + store`)
- Permission witnesses via TypeName (supports any `drop` type)
- Core functions: `grant_permission`, `revoke_permission`, `has_permission`
- Object-based auth: `object_grant_permission`, `object_revoke_permission`, `object_remove_member`
- UID access: `object_uid`, `object_uid_mut` (require `ObjectAdmin` via actor-object pattern)
- Lifecycle: `new`, `new_derived`, `delete` (requires `GroupDeleter`), `pause` (requires `PermissionsAdmin`), `unpause` (requires `UnpauseCap`)
- Events: `GroupCreated`, `GroupDerived`, `GroupDeleted`, `GroupPaused`, `GroupUnpaused`, `PermissionsGranted`, `PermissionsRevoked`, `MemberAdded`, `MemberRemoved`

**permissions_table.move**:
- `PermissionsTable` derived object storing member → permission set mapping
- `destroy_empty`: deletes an empty table (called after `permissioned_group::delete`)

**unpause_cap.move**:
- `UnpauseCap<T>`: capability returned by `permissioned_group::pause()`, required to call `unpause()`
- `burn()`: destroys the cap without unpausing — used by `messaging::archive_group` for permanent archival

**display.move**:
- MySo Display standard registration for `PermissionedGroup<T>`

### Layer 2: messaging

Wrapper providing messaging-specific functionality.

**messaging.move**:
- `MessagingNamespace` shared object for group creation and actor derivation
- `Messaging` witness type for `PermissionedGroup<Messaging>`
- Messaging permission witnesses: `MessagingSender`, `MessagingReader`, `MessagingEditor`, `MessagingDeleter`, `MySoNsAdmin`, `MetadataAdmin`
- `create_group`: creates group + encryption history + attaches metadata + grants all permissions to creator
- `create_and_share_group`: entry function wrapping `create_group`
- `rotate_encryption_key`: rotates the DEK (requires `EncryptionKeyRotator`)
- `leave`: self-service leave via `GroupLeaver` actor
- `archive_group`: entry function — pauses the group and burns the `UnpauseCap`, making the group permanently immutable (requires `PermissionsAdmin`)
- MySoNS functions: `set_mysons_reverse_lookup`, `unset_mysons_reverse_lookup` (require `MySoNsAdmin`)
- Metadata functions: `set_group_name`, `insert_group_data`, `remove_group_data` (require `MetadataAdmin`)

**encryption_history.move**:
- `EncryptionHistory` derived object from `MessagingNamespace`
- Versioned encrypted DEK storage
- Key rotation support via `rotate_key`
- `EncryptionKeyRotator` permission witness (re-exported from this module)

**mydata_policies.move**:
- `mydata_approve_reader`: Validates `MessagingReader` permission (via dry-run)
- `validate_identity()`: public function that parses and validates the standard identity bytes format `[group_id (32 bytes)][key_version (8 bytes LE u64)]`; intended to be called by custom `mydata_approve` implementations in third-party packages

**group_leaver.move**:
- `GroupLeaver` singleton derived from `MessagingNamespace`
- Holds `PermissionsAdmin` on every group; enables `leave()` for any member without requiring that member to hold admin permissions

**group_manager.move**:
- `GroupManager` singleton derived from `MessagingNamespace`
- Holds `ObjectAdmin` on every group; exposes MySoNS and metadata management via `object_uid_mut`

**metadata.move**:
- `Metadata` struct stored as a dynamic field on `PermissionedGroup<Messaging>`
- Immutable: `uuid`, `creator`; mutable: `name`, `data`
- Size limits: name ≤ 128 bytes, data key ≤ 64 bytes, data value ≤ 256 bytes
- `MetadataKey(u64)` versioned key to support future schema migrations

**version.move**:
- `Version` shared object tracking the messaging package version (messaging package only — not used by permissioned_groups)
- `validate_version()` called at the top of every entry function in the messaging package
- Upgrade migrations bump the version via a `migrate` entry function (currently commented out pending the first upgrade)

### Layer 3: example_app

Example third-party implementations.

**paid_join_rule.move**:
- Payment-gated group membership using actor pattern
- `PaidJoinRule<Token>` actor with fee configuration
- Accumulates fees with `FundsManager` withdrawal permission

**custom_mydata_policy.move**:
- Subscription-based access control
- Custom namespace using Service ID
- Time-limited subscriptions with TTL
