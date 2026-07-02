/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/

/**
 * Module: messaging
 *
 * Public-facing module for the messaging package. All external interactions should
 * go through this module.
 *
 * Wraps `permissions_group` to provide messaging-specific permission management,
 * `encryption_history` for key rotation, and `message_log` for **paid** `MYSO`
 * escrow only.
 *
 * ## Permissions
 *
 * From groups (auto-granted to creator):
 *
 * - `PermissionsAdmin`: Manages core permissions (from permissioned_groups
 *   package)
 * - `ExtensionPermissionsAdmin`: Manages extension permissions (from other
 *   packages)
 *
 * Messaging-specific:
 *
 * - `MessagingSender`: Send messages
 * - `MessagingReader`: Read/decrypt messages
 * - `MessagingEditor`: Edit messages
 * - `MessagingDeleter`: Delete messages
 * - `EncryptionKeyRotator`: Rotate encryption keys
 * - `GroupHandleAdmin`: Register or clear this group's handle in
 *   [`group_handle_registry::GroupHandleRegistry`]
 * - `MetadataAdmin`: Edit group metadata (name, data)
 *
 * ## Security
 *
 * - Membership is defined by having at least one permission
 * - Granting a permission implicitly adds the member if they don't exist
 * - Revoking the last permission automatically removes the member
 */

import {
	MoveTuple,
	MoveStruct,
	normalizeMoveArguments,
	type RawTransactionArgument,
} from '../utils/index.js';
import { bcs } from '@socialproof/myso/bcs';
import { type Transaction } from '@socialproof/myso/transactions';
const $moduleName = '@local-pkg/messaging::messaging';
export const MESSAGING = new MoveTuple({ name: `${$moduleName}::MESSAGING`, fields: [bcs.bool()] });
export const Messaging = new MoveTuple({ name: `${$moduleName}::Messaging`, fields: [bcs.bool()] });
export const MessagingSender = new MoveTuple({
	name: `${$moduleName}::MessagingSender`,
	fields: [bcs.bool()],
});
export const MessagingReader = new MoveTuple({
	name: `${$moduleName}::MessagingReader`,
	fields: [bcs.bool()],
});
export const MessagingDeleter = new MoveTuple({
	name: `${$moduleName}::MessagingDeleter`,
	fields: [bcs.bool()],
});
export const MessagingEditor = new MoveTuple({
	name: `${$moduleName}::MessagingEditor`,
	fields: [bcs.bool()],
});
export const GroupHandleAdmin = new MoveTuple({
	name: `${$moduleName}::GroupHandleAdmin`,
	fields: [bcs.bool()],
});
export const MetadataAdmin = new MoveTuple({
	name: `${$moduleName}::MetadataAdmin`,
	fields: [bcs.bool()],
});
export const MessagingNamespace = new MoveStruct({
	name: `${$moduleName}::MessagingNamespace`,
	fields: {
		id: bcs.Address,
	},
});
export const AgentGroupCreated = new MoveStruct({
	name: `${$moduleName}::AgentGroupCreated`,
	fields: {
		group_id: bcs.Address,
		creator_actor: bcs.Address,
		creator_principal: bcs.Address,
		creator_sub_agent_id: bcs.option(bcs.Address),
		creator_identity_class: bcs.u64(),
		organization_id: bcs.option(bcs.Address),
		group_name: bcs.string(),
		group_uuid: bcs.string(),
		created_at: bcs.u64(),
	},
});
export interface CreateGroupArguments {
	version: RawTransactionArgument<string>;
	namespace: RawTransactionArgument<string>;
	groupManager: RawTransactionArgument<string>;
	blockList: RawTransactionArgument<string>;
	creatorMemoryAccount: RawTransactionArgument<string>;
	name: RawTransactionArgument<string>;
	uuid: RawTransactionArgument<string>;
	initialEncryptedDek: RawTransactionArgument<number[]>;
	initialMembers: RawTransactionArgument<string>;
}
export interface CreateGroupOptions {
	package?: string;
	arguments:
		| CreateGroupArguments
		| [
				version: RawTransactionArgument<string>,
				namespace: RawTransactionArgument<string>,
				groupManager: RawTransactionArgument<string>,
				blockList: RawTransactionArgument<string>,
				creatorMemoryAccount: RawTransactionArgument<string>,
				name: RawTransactionArgument<string>,
				uuid: RawTransactionArgument<string>,
				initialEncryptedDek: RawTransactionArgument<number[]>,
				initialMembers: RawTransactionArgument<string>,
		  ];
}
/**
 * Creates a new messaging group with encryption. The transaction sender
 * (`ctx.sender()`) automatically becomes the creator with all permissions.
 *
 * # Parameters
 *
 * - `version`: Reference to the Version shared object
 * - `namespace`: Mutable reference to the MessagingNamespace
 * - `group_manager`: Reference to the shared GroupManager actor
 * - `name`: Human-readable group name
 * - `uuid`: Client-provided UUID for deterministic address derivation
 * - `initial_encrypted_dek`: Initial MyData-encrypted DEK bytes
 * - `initial_members`: Addresses to grant `MessagingReader` permission (should not
 *   include creator)
 * - `ctx`: Transaction context
 *
 * # Returns
 *
 * Tuple of `(PermissionedGroup<Messaging>, EncryptionHistory, MessageLog)`.
 *
 * # Note
 *
 * If `initial_members` contains the creator's address, it is silently skipped (no
 * abort). This handles the common case where the creator might be mistakenly
 * included in the initial members list.
 *
 * # Aborts
 *
 * - `EInvalidVersion` (from `version`): if package version doesn't match
 * - If the UUID has already been used (duplicate derivation)
 */
export function createGroup(options: CreateGroupOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [
		null,
		null,
		null,
		null,
		null,
		'0x1::string::String',
		'0x1::string::String',
		'vector<u8>',
		null,
	] satisfies (string | null)[];
	const parameterNames = [
		'version',
		'namespace',
		'groupManager',
		'blockList',
		'creatorMemoryAccount',
		'name',
		'uuid',
		'initialEncryptedDek',
		'initialMembers',
	];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'create_group',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface CreateAndShareGroupArguments {
	version: RawTransactionArgument<string>;
	namespace: RawTransactionArgument<string>;
	groupManager: RawTransactionArgument<string>;
	blockList: RawTransactionArgument<string>;
	creatorMemoryAccount: RawTransactionArgument<string>;
	name: RawTransactionArgument<string>;
	uuid: RawTransactionArgument<string>;
	initialEncryptedDek: RawTransactionArgument<number[]>;
	initialMembers: RawTransactionArgument<string[]>;
}
export interface CreateAndShareGroupOptions {
	package?: string;
	arguments:
		| CreateAndShareGroupArguments
		| [
				version: RawTransactionArgument<string>,
				namespace: RawTransactionArgument<string>,
				groupManager: RawTransactionArgument<string>,
				blockList: RawTransactionArgument<string>,
				creatorMemoryAccount: RawTransactionArgument<string>,
				name: RawTransactionArgument<string>,
				uuid: RawTransactionArgument<string>,
				initialEncryptedDek: RawTransactionArgument<number[]>,
				initialMembers: RawTransactionArgument<string[]>,
		  ];
}
/**
 * Creates a new messaging group and shares both objects.
 *
 * # Parameters
 *
 * - `version`: Reference to the Version shared object
 * - `namespace`: Mutable reference to the MessagingNamespace
 * - `group_manager`: Reference to the shared GroupManager actor
 * - `name`: Human-readable group name
 * - `uuid`: Client-provided UUID for deterministic address derivation
 * - `initial_encrypted_dek`: Initial MyData-encrypted DEK bytes
 * - `initial_members`: Set of addresses to grant `MessagingReader` permission
 * - `ctx`: Transaction context
 *
 * # Note
 *
 * See `create_group` for details on creator permissions and initial member
 * handling.
 */
export function createAndShareGroup(options: CreateAndShareGroupOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [
		null,
		null,
		null,
		null,
		null,
		'0x1::string::String',
		'0x1::string::String',
		'vector<u8>',
		'vector<address>',
	] satisfies (string | null)[];
	const parameterNames = [
		'version',
		'namespace',
		'groupManager',
		'blockList',
		'creatorMemoryAccount',
		'name',
		'uuid',
		'initialEncryptedDek',
		'initialMembers',
	];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'create_and_share_group',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface CreateWalletGroupArguments {
	version: RawTransactionArgument<string>;
	namespace: RawTransactionArgument<string>;
	groupManager: RawTransactionArgument<string>;
	blockList: RawTransactionArgument<string>;
	name: RawTransactionArgument<string>;
	uuid: RawTransactionArgument<string>;
	initialEncryptedDek: RawTransactionArgument<number[]>;
	initialMembers: RawTransactionArgument<string>;
}
export interface CreateWalletGroupOptions {
	package?: string;
	arguments:
		| CreateWalletGroupArguments
		| [
				version: RawTransactionArgument<string>,
				namespace: RawTransactionArgument<string>,
				groupManager: RawTransactionArgument<string>,
				blockList: RawTransactionArgument<string>,
				name: RawTransactionArgument<string>,
				uuid: RawTransactionArgument<string>,
				initialEncryptedDek: RawTransactionArgument<number[]>,
				initialMembers: RawTransactionArgument<string>,
		  ];
}
/**
 * Wallet-only group creation. Creator is `ctx.sender()`; no [`MemoryAccount`]
 * required.
 *
 * Use when the sender has no linked profile/memory account. For profile owners
 * with a [`MemoryAccount`], prefer [`create_group`] which enforces human-only
 * creation.
 */
export function createWalletGroup(options: CreateWalletGroupOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [
		null,
		null,
		null,
		null,
		'0x1::string::String',
		'0x1::string::String',
		'vector<u8>',
		null,
	] satisfies (string | null)[];
	const parameterNames = [
		'version',
		'namespace',
		'groupManager',
		'blockList',
		'name',
		'uuid',
		'initialEncryptedDek',
		'initialMembers',
	];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'create_wallet_group',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface CreateAndShareWalletGroupArguments {
	version: RawTransactionArgument<string>;
	namespace: RawTransactionArgument<string>;
	groupManager: RawTransactionArgument<string>;
	blockList: RawTransactionArgument<string>;
	name: RawTransactionArgument<string>;
	uuid: RawTransactionArgument<string>;
	initialEncryptedDek: RawTransactionArgument<number[]>;
	initialMembers: RawTransactionArgument<string[]>;
}
export interface CreateAndShareWalletGroupOptions {
	package?: string;
	arguments:
		| CreateAndShareWalletGroupArguments
		| [
				version: RawTransactionArgument<string>,
				namespace: RawTransactionArgument<string>,
				groupManager: RawTransactionArgument<string>,
				blockList: RawTransactionArgument<string>,
				name: RawTransactionArgument<string>,
				uuid: RawTransactionArgument<string>,
				initialEncryptedDek: RawTransactionArgument<number[]>,
				initialMembers: RawTransactionArgument<string[]>,
		  ];
}
/** Entry point: create and share a group without a [`MemoryAccount`]. */
export function createAndShareWalletGroup(options: CreateAndShareWalletGroupOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [
		null,
		null,
		null,
		null,
		'0x1::string::String',
		'0x1::string::String',
		'vector<u8>',
		'vector<address>',
	] satisfies (string | null)[];
	const parameterNames = [
		'version',
		'namespace',
		'groupManager',
		'blockList',
		'name',
		'uuid',
		'initialEncryptedDek',
		'initialMembers',
	];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'create_and_share_wallet_group',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface CreateAgentGroupArguments {
	version: RawTransactionArgument<string>;
	namespace: RawTransactionArgument<string>;
	groupManager: RawTransactionArgument<string>;
	groupLeaver: RawTransactionArgument<string>;
	blockList: RawTransactionArgument<string>;
	platform: RawTransactionArgument<string>;
	creatorMemoryAccount: RawTransactionArgument<string>;
	crossPrincipalPeerAccount: RawTransactionArgument<string>;
	name: RawTransactionArgument<string>;
	uuid: RawTransactionArgument<string>;
	initialEncryptedDek: RawTransactionArgument<number[]>;
	initialMembers: RawTransactionArgument<string>;
}
export interface CreateAgentGroupOptions {
	package?: string;
	arguments:
		| CreateAgentGroupArguments
		| [
				version: RawTransactionArgument<string>,
				namespace: RawTransactionArgument<string>,
				groupManager: RawTransactionArgument<string>,
				groupLeaver: RawTransactionArgument<string>,
				blockList: RawTransactionArgument<string>,
				platform: RawTransactionArgument<string>,
				creatorMemoryAccount: RawTransactionArgument<string>,
				crossPrincipalPeerAccount: RawTransactionArgument<string>,
				name: RawTransactionArgument<string>,
				uuid: RawTransactionArgument<string>,
				initialEncryptedDek: RawTransactionArgument<number[]>,
				initialMembers: RawTransactionArgument<string>,
		  ];
}
/**
 * Creates a messaging group on behalf of a sub-agent with principal oversight.
 *
 * The transaction sender must be the sub-agent `derived_address` with
 * `CAP_MESSAGE_SEND`. The agent receives messaging permissions but not
 * `PermissionsAdmin`. The human `principal_owner` receives `MessagingReader` and
 * `PermissionsAdmin`.
 *
 * For cross-principal agent peers in `initial_members`, pass their
 * [`MemoryAccount`] as `cross_principal_peer_account`. When all peers are humans
 * or agents under the same principal, pass the creator account again.
 */
export function createAgentGroup(options: CreateAgentGroupOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		'0x1::string::String',
		'0x1::string::String',
		'vector<u8>',
		null,
		'0x2::clock::Clock',
	] satisfies (string | null)[];
	const parameterNames = [
		'version',
		'namespace',
		'groupManager',
		'groupLeaver',
		'blockList',
		'platform',
		'creatorMemoryAccount',
		'crossPrincipalPeerAccount',
		'name',
		'uuid',
		'initialEncryptedDek',
		'initialMembers',
	];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'create_agent_group',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface CreateAgentAndShareGroupArguments {
	version: RawTransactionArgument<string>;
	namespace: RawTransactionArgument<string>;
	groupManager: RawTransactionArgument<string>;
	groupLeaver: RawTransactionArgument<string>;
	blockList: RawTransactionArgument<string>;
	platform: RawTransactionArgument<string>;
	creatorMemoryAccount: RawTransactionArgument<string>;
	crossPrincipalPeerAccount: RawTransactionArgument<string>;
	name: RawTransactionArgument<string>;
	uuid: RawTransactionArgument<string>;
	initialEncryptedDek: RawTransactionArgument<number[]>;
	initialMembers: RawTransactionArgument<string[]>;
	clock: RawTransactionArgument<string>;
}
export interface CreateAgentAndShareGroupOptions {
	package?: string;
	arguments:
		| CreateAgentAndShareGroupArguments
		| [
				version: RawTransactionArgument<string>,
				namespace: RawTransactionArgument<string>,
				groupManager: RawTransactionArgument<string>,
				groupLeaver: RawTransactionArgument<string>,
				blockList: RawTransactionArgument<string>,
				platform: RawTransactionArgument<string>,
				creatorMemoryAccount: RawTransactionArgument<string>,
				crossPrincipalPeerAccount: RawTransactionArgument<string>,
				name: RawTransactionArgument<string>,
				uuid: RawTransactionArgument<string>,
				initialEncryptedDek: RawTransactionArgument<number[]>,
				initialMembers: RawTransactionArgument<string[]>,
				clock: RawTransactionArgument<string>,
		  ];
}
/** Entry point: create and share an agent-associated messaging group. */
export function createAgentAndShareGroup(options: CreateAgentAndShareGroupOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		'0x1::string::String',
		'0x1::string::String',
		'vector<u8>',
		'vector<address>',
		'0x2::clock::Clock',
	] satisfies (string | null)[];
	const parameterNames = [
		'version',
		'namespace',
		'groupManager',
		'groupLeaver',
		'blockList',
		'platform',
		'creatorMemoryAccount',
		'crossPrincipalPeerAccount',
		'name',
		'uuid',
		'initialEncryptedDek',
		'initialMembers',
	];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'create_agent_and_share_group',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface RotateEncryptionKeyArguments {
	version: RawTransactionArgument<string>;
	encryptionHistory: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	newEncryptedDek: RawTransactionArgument<number[]>;
}
export interface RotateEncryptionKeyOptions {
	package?: string;
	arguments:
		| RotateEncryptionKeyArguments
		| [
				version: RawTransactionArgument<string>,
				encryptionHistory: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
				newEncryptedDek: RawTransactionArgument<number[]>,
		  ];
}
/**
 * Rotates the encryption key for a group.
 *
 * # Parameters
 *
 * - `encryption_history`: Mutable reference to the group's EncryptionHistory
 * - `group`: Reference to the PermissionedGroup<Messaging>
 * - `new_encrypted_dek`: New MyData-encrypted DEK bytes
 * - `ctx`: Transaction context
 *
 * # Aborts
 *
 * - `EInvalidVersion` (from `version`): if package version doesn't match
 * - `ENotPermitted`: if caller doesn't have `EncryptionKeyRotator` permission
 */
export function rotateEncryptionKey(options: RotateEncryptionKeyOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null, null, null, 'vector<u8>'] satisfies (string | null)[];
	const parameterNames = ['version', 'encryptionHistory', 'group', 'newEncryptedDek'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'rotate_encryption_key',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface LeaveArguments {
	groupLeaver: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
}
export interface LeaveOptions {
	package?: string;
	arguments:
		| LeaveArguments
		| [groupLeaver: RawTransactionArgument<string>, group: RawTransactionArgument<string>];
}
/**
 * Removes the caller from a messaging group. The `GroupLeaver` actor holds
 * `PermissionsAdmin` on all groups and calls `object_remove_member` on behalf of
 * the caller.
 *
 * `PermissionsAdmin` holders cannot use this function. Since they already have
 * `PermissionsAdmin`, they can call `permissioned_group::remove_member()` for
 * their own address instead. Alternatively, they can first revoke their own
 * `PermissionsAdmin` and then call `leave()`.
 *
 * **Why**: `leave()` is a self-service action via the `GroupLeaver` actor object.
 * Since `permissions_admin_count` includes both human and actor-object admins,
 * there is no reliable way to determine whether removing the caller would leave
 * the group without a human admin. Blocking `PermissionsAdmin` holders from
 * `leave()` makes this a deliberate admin decision rather than a casual action.
 *
 * **Limitation**: Note that `permissions_admin_count` is a best-effort invariant.
 * Even via `remove_member()`, a group could end up with only actor-object admins
 * if the caller removes themselves when they are the last human admin. The count
 * cannot distinguish human from actor-object holders.
 *
 * # Parameters
 *
 * - `group_leaver`: Reference to the shared `GroupLeaver` object
 * - `group`: Mutable reference to the `PermissionedGroup<Messaging>`
 * - `ctx`: Transaction context
 *
 * # Aborts
 *
 * - `EPermissionsAdminCannotLeave`: if the caller holds `PermissionsAdmin`
 * - `EMemberNotFound` (from `permissioned_group`): if the caller is not a member
 */
export function leave(options: LeaveOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null, null] satisfies (string | null)[];
	const parameterNames = ['groupLeaver', 'group'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'leave',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface ArchiveGroupArguments {
	version: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
}
export interface ArchiveGroupOptions {
	package?: string;
	arguments:
		| ArchiveGroupArguments
		| [version: RawTransactionArgument<string>, group: RawTransactionArgument<string>];
}
/**
 * Permanently archives a messaging group.
 *
 * Pauses the group and burns the `UnpauseCap`, making it impossible to unpause.
 * After this call, `is_paused()` returns `true` and all mutations are blocked.
 *
 * The caller must have `PermissionsAdmin` permission (enforced by `pause()`).
 *
 * # Aborts
 *
 * - `ENotPermitted` (from `pause`): if caller doesn't have `PermissionsAdmin`
 * - `EAlreadyPaused` (from `pause`): if the group is already paused
 *
 * # Note
 *
 * Alternative to burning: `transfer::public_freeze_object(cap)` makes the cap
 * immutable and un-passable by value, also preventing unpause without destroying
 * the object.
 */
export function archiveGroup(options: ArchiveGroupOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null, null] satisfies (string | null)[];
	const parameterNames = ['version', 'group'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'archive_group',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface SetGroupHandleArguments {
	version: RawTransactionArgument<string>;
	registry: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	handle: RawTransactionArgument<string>;
}
export interface SetGroupHandleOptions {
	package?: string;
	arguments:
		| SetGroupHandleArguments
		| [
				version: RawTransactionArgument<string>,
				registry: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
				handle: RawTransactionArgument<string>,
		  ];
}
/**
 * Registers or replaces the canonical handle for this group in the shared
 * [`GroupHandleRegistry`].
 *
 * The caller must have `GroupHandleAdmin`. See `group_handle_registry::set_handle`
 * for handle rules.
 *
 * # Aborts
 *
 * - `ENotPermitted`: if caller doesn't have `GroupHandleAdmin`
 * - `EGroupArchived`: if the group is paused
 * - `group_handle_registry::EHandleTaken` / `EInvalidHandle`: from the registry
 */
export function setGroupHandle(options: SetGroupHandleOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null, null, null, '0x1::string::String'] satisfies (string | null)[];
	const parameterNames = ['version', 'registry', 'group', 'handle'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'set_group_handle',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface ClearGroupHandleArguments {
	version: RawTransactionArgument<string>;
	registry: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
}
export interface ClearGroupHandleOptions {
	package?: string;
	arguments:
		| ClearGroupHandleArguments
		| [
				version: RawTransactionArgument<string>,
				registry: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
		  ];
}
/**
 * Removes this group's handle from the registry, if any.
 *
 * # Aborts
 *
 * - `ENotPermitted`: if caller doesn't have `GroupHandleAdmin`
 * - `EGroupArchived`: if the group is paused
 */
export function clearGroupHandle(options: ClearGroupHandleOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null, null, null] satisfies (string | null)[];
	const parameterNames = ['version', 'registry', 'group'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'clear_group_handle',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface LookupGroupByHandleArguments {
	registry: RawTransactionArgument<string>;
	handle: RawTransactionArgument<string>;
}
export interface LookupGroupByHandleOptions {
	package?: string;
	arguments:
		| LookupGroupByHandleArguments
		| [registry: RawTransactionArgument<string>, handle: RawTransactionArgument<string>];
}
/**
 * Read-only: resolve a handle to a group object ID. Does not require
 * `GroupHandleAdmin`.
 */
export function lookupGroupByHandle(options: LookupGroupByHandleOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null, '0x1::string::String'] satisfies (string | null)[];
	const parameterNames = ['registry', 'handle'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'lookup_group_by_handle',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface SetGroupNameArguments {
	groupManager: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	name: RawTransactionArgument<string>;
}
export interface SetGroupNameOptions {
	package?: string;
	arguments:
		| SetGroupNameArguments
		| [
				groupManager: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
				name: RawTransactionArgument<string>,
		  ];
}
/**
 * Sets the group name. Caller must have `MetadataAdmin` permission.
 *
 * # Aborts
 *
 * - `ENotPermitted`: if caller doesn't have `MetadataAdmin`
 * - `ENameTooLong` (from `metadata`): if name exceeds limit
 */
export function setGroupName(options: SetGroupNameOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null, null, '0x1::string::String'] satisfies (string | null)[];
	const parameterNames = ['groupManager', 'group', 'name'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'set_group_name',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface InsertGroupDataArguments {
	groupManager: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	key: RawTransactionArgument<string>;
	value: RawTransactionArgument<string>;
}
export interface InsertGroupDataOptions {
	package?: string;
	arguments:
		| InsertGroupDataArguments
		| [
				groupManager: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
				key: RawTransactionArgument<string>,
				value: RawTransactionArgument<string>,
		  ];
}
/**
 * Inserts a key-value pair into the group's metadata data map. Caller must have
 * `MetadataAdmin` permission.
 *
 * # Aborts
 *
 * - `ENotPermitted`: if caller doesn't have `MetadataAdmin`
 * - `EDataKeyTooLong` (from `metadata`): if key exceeds limit
 * - `EDataValueTooLong` (from `metadata`): if value exceeds limit
 */
export function insertGroupData(options: InsertGroupDataOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null, null, '0x1::string::String', '0x1::string::String'] satisfies (
		| string
		| null
	)[];
	const parameterNames = ['groupManager', 'group', 'key', 'value'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'insert_group_data',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface RemoveGroupDataArguments {
	groupManager: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	key: RawTransactionArgument<string>;
}
export interface RemoveGroupDataOptions {
	package?: string;
	arguments:
		| RemoveGroupDataArguments
		| [
				groupManager: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
				key: RawTransactionArgument<string>,
		  ];
}
/**
 * Removes a key-value pair from the group's metadata data map. Caller must have
 * `MetadataAdmin` permission.
 *
 * # Returns
 *
 * The removed (key, value) tuple.
 *
 * # Aborts
 *
 * - `ENotPermitted`: if caller doesn't have `MetadataAdmin`
 */
export function removeGroupData(options: RemoveGroupDataOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null, null, '0x1::string::String'] satisfies (string | null)[];
	const parameterNames = ['groupManager', 'group', 'key'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'remove_group_data',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface SendPaidMessageDigestArguments {
	version: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	log: RawTransactionArgument<string>;
	paidRegistry: RawTransactionArgument<string>;
	socialGraph: RawTransactionArgument<string>;
	blockList: RawTransactionArgument<string>;
	groupManager: RawTransactionArgument<string>;
	recipient: RawTransactionArgument<string>;
	payment: RawTransactionArgument<string>;
	escrowAmount: RawTransactionArgument<number | bigint>;
	dedupeKey: RawTransactionArgument<number[]>;
	nonce: RawTransactionArgument<number | bigint>;
}
export interface SendPaidMessageDigestOptions {
	package?: string;
	arguments:
		| SendPaidMessageDigestArguments
		| [
				version: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
				log: RawTransactionArgument<string>,
				paidRegistry: RawTransactionArgument<string>,
				socialGraph: RawTransactionArgument<string>,
				blockList: RawTransactionArgument<string>,
				groupManager: RawTransactionArgument<string>,
				recipient: RawTransactionArgument<string>,
				payment: RawTransactionArgument<string>,
				escrowAmount: RawTransactionArgument<number | bigint>,
				dedupeKey: RawTransactionArgument<number[]>,
				nonce: RawTransactionArgument<number | bigint>,
		  ];
}
/**
 * Escrow `escrow_amount` from `payment` for a paid message. Requires
 * `MessagingSender`. Excess coin returns to the sender.
 */
export function sendPaidMessageDigest(options: SendPaidMessageDigestOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		'address',
		null,
		'u64',
		'vector<u8>',
		'u128',
		'0x2::clock::Clock',
	] satisfies (string | null)[];
	const parameterNames = [
		'version',
		'group',
		'log',
		'paidRegistry',
		'socialGraph',
		'blockList',
		'groupManager',
		'recipient',
		'payment',
		'escrowAmount',
		'dedupeKey',
		'nonce',
	];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'send_paid_message_digest',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface SendAgentPaidMessageDigestArguments {
	version: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	log: RawTransactionArgument<string>;
	paidRegistry: RawTransactionArgument<string>;
	socialGraph: RawTransactionArgument<string>;
	blockList: RawTransactionArgument<string>;
	groupManager: RawTransactionArgument<string>;
	platform: RawTransactionArgument<string>;
	memoryAccount: RawTransactionArgument<string>;
	recipient: RawTransactionArgument<string>;
	payment: RawTransactionArgument<string>;
	escrowAmount: RawTransactionArgument<number | bigint>;
	dedupeKey: RawTransactionArgument<number[]>;
	nonce: RawTransactionArgument<number | bigint>;
}
export interface SendAgentPaidMessageDigestOptions {
	package?: string;
	arguments:
		| SendAgentPaidMessageDigestArguments
		| [
				version: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
				log: RawTransactionArgument<string>,
				paidRegistry: RawTransactionArgument<string>,
				socialGraph: RawTransactionArgument<string>,
				blockList: RawTransactionArgument<string>,
				groupManager: RawTransactionArgument<string>,
				platform: RawTransactionArgument<string>,
				memoryAccount: RawTransactionArgument<string>,
				recipient: RawTransactionArgument<string>,
				payment: RawTransactionArgument<string>,
				escrowAmount: RawTransactionArgument<number | bigint>,
				dedupeKey: RawTransactionArgument<number[]>,
				nonce: RawTransactionArgument<number | bigint>,
		  ];
}
/**
 * Agent variant of [`send_paid_message_digest`]. Resolves the sub-agent actor and
 * evaluates paid-DM / social-graph rules against the human `principal_owner`.
 */
export function sendAgentPaidMessageDigest(options: SendAgentPaidMessageDigestOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		'address',
		null,
		'u64',
		'vector<u8>',
		'u128',
		'0x2::clock::Clock',
	] satisfies (string | null)[];
	const parameterNames = [
		'version',
		'group',
		'log',
		'paidRegistry',
		'socialGraph',
		'blockList',
		'groupManager',
		'platform',
		'memoryAccount',
		'recipient',
		'payment',
		'escrowAmount',
		'dedupeKey',
		'nonce',
	];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'send_agent_paid_message_digest',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface ReplyToPaidMessageClaimCoinArguments {
	version: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	log: RawTransactionArgument<string>;
	blockList: RawTransactionArgument<string>;
	paidMsgSeq: RawTransactionArgument<number | bigint>;
	charCount: RawTransactionArgument<number>;
	dedupeKey: RawTransactionArgument<number[]>;
	nonce: RawTransactionArgument<number | bigint>;
}
export interface ReplyToPaidMessageClaimCoinOptions {
	package?: string;
	arguments:
		| ReplyToPaidMessageClaimCoinArguments
		| [
				version: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
				log: RawTransactionArgument<string>,
				blockList: RawTransactionArgument<string>,
				paidMsgSeq: RawTransactionArgument<number | bigint>,
				charCount: RawTransactionArgument<number>,
				dedupeKey: RawTransactionArgument<number[]>,
				nonce: RawTransactionArgument<number | bigint>,
		  ];
}
/**
 * Reply to a paid message and take full escrow as coin. Caller may split fees
 * (e.g. via [`reply_to_paid_message_claim_settled`]) or use this entry for custom
 * routing.
 */
export function replyToPaidMessageClaimCoin(options: ReplyToPaidMessageClaimCoinOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [
		null,
		null,
		null,
		null,
		'u64',
		'u32',
		'vector<u8>',
		'u128',
		'0x2::clock::Clock',
	] satisfies (string | null)[];
	const parameterNames = [
		'version',
		'group',
		'log',
		'blockList',
		'paidMsgSeq',
		'charCount',
		'dedupeKey',
		'nonce',
	];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'reply_to_paid_message_claim_coin',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface ReplyToPaidMessageClaimSettledArguments {
	version: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	log: RawTransactionArgument<string>;
	blockList: RawTransactionArgument<string>;
	paidMsgSeq: RawTransactionArgument<number | bigint>;
	charCount: RawTransactionArgument<number>;
	dedupeKey: RawTransactionArgument<number[]>;
	nonce: RawTransactionArgument<number | bigint>;
	platformFeeRecipient: RawTransactionArgument<string>;
	ecosystemTreasury: RawTransactionArgument<string>;
}
export interface ReplyToPaidMessageClaimSettledOptions {
	package?: string;
	arguments:
		| ReplyToPaidMessageClaimSettledArguments
		| [
				version: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
				log: RawTransactionArgument<string>,
				blockList: RawTransactionArgument<string>,
				paidMsgSeq: RawTransactionArgument<number | bigint>,
				charCount: RawTransactionArgument<number>,
				dedupeKey: RawTransactionArgument<number[]>,
				nonce: RawTransactionArgument<number | bigint>,
				platformFeeRecipient: RawTransactionArgument<string>,
				ecosystemTreasury: RawTransactionArgument<string>,
		  ];
}
/**
 * Reply and settle: same validation as [`reply_to_paid_message_claim_coin`], then
 * split escrow per paid-message BPS to `platform_fee_recipient` and the ecosystem
 * treasury address from `ecosystem_treasury` (via `profile::get_treasury_address`),
 * with net to the paid-message recipient.
 */
export function replyToPaidMessageClaimSettled(options: ReplyToPaidMessageClaimSettledOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [
		null,
		null,
		null,
		null,
		'u64',
		'u32',
		'vector<u8>',
		'u128',
		'0x2::clock::Clock',
		'address',
		null,
	] satisfies (string | null)[];
	const parameterNames = [
		'version',
		'group',
		'log',
		'blockList',
		'paidMsgSeq',
		'charCount',
		'dedupeKey',
		'nonce',
		'platformFeeRecipient',
		'ecosystemTreasury',
	];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'reply_to_paid_message_claim_settled',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface RefundPaidEscrowArguments {
	version: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	log: RawTransactionArgument<string>;
	blockList: RawTransactionArgument<string>;
	paidMsgSeq: RawTransactionArgument<number | bigint>;
}
export interface RefundPaidEscrowOptions {
	package?: string;
	arguments:
		| RefundPaidEscrowArguments
		| [
				version: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
				log: RawTransactionArgument<string>,
				blockList: RawTransactionArgument<string>,
				paidMsgSeq: RawTransactionArgument<number | bigint>,
		  ];
}
/**
 * Refund expired paid escrow to the payer. Requires `MessagingSender` (payer must
 * be a member).
 */
export function refundPaidEscrow(options: RefundPaidEscrowOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null, null, null, null, 'u64', '0x2::clock::Clock'] satisfies (
		| string
		| null
	)[];
	const parameterNames = ['version', 'group', 'log', 'blockList', 'paidMsgSeq'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'refund_paid_escrow',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
