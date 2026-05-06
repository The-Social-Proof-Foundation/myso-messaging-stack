/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/

/**
 * Module: messaging
 *
 * Public-facing module for the messaging package. All external interactions should
 * go through this module.
 *
 * Wraps `permissions_group` to provide messaging-specific permission management
 * and `encryption_history` for key rotation.
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
 * - `MySoNsAdmin`: Manage MySoNS reverse lookups on the group
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
const $moduleName = '@local-pkg/myso-messaging-stack::messaging';
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
export const MySoNsAdmin = new MoveTuple({
	name: `${$moduleName}::MySoNsAdmin`,
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
export interface CreateGroupArguments {
	version: RawTransactionArgument<string>;
	namespace: RawTransactionArgument<string>;
	groupManager: RawTransactionArgument<string>;
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
 * Tuple of `(PermissionedGroup<Messaging>, EncryptionHistory)`.
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
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
	const argumentsTypes = [
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
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
	const argumentsTypes = [
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
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
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
 * # Parameters
 *
 * - `group_leaver`: Reference to the shared `GroupLeaver` object
 * - `group`: Mutable reference to the `PermissionedGroup<Messaging>`
 * - `ctx`: Transaction context
 *
 * # Aborts
 *
 * - `EMemberNotFound` (from `permissioned_group`): if the caller is not a member
 * - `ELastPermissionsAdmin` (from `permissioned_group`): if the caller is the last
 *   `PermissionsAdmin` holder (including actor objects)
 *
 * NOTE: Because `GroupLeaver` itself holds `PermissionsAdmin` on every group, a
 * human admin can always leave — leaving `GroupLeaver` as the sole remaining
 * admin. A group in that state has no human admins. To promote a new human admin
 * from that state, a dedicated actor-object wrapper over `object_grant_permission`
 * would be needed.
 */
export function leave(options: LeaveOptions) {
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
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
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
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
export interface SetMySonsReverseLookupArguments {
	groupManager: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	mysons: RawTransactionArgument<string>;
	domainName: RawTransactionArgument<string>;
}
export interface SetMySonsReverseLookupOptions {
	package?: string;
	arguments:
		| SetMySonsReverseLookupArguments
		| [
				groupManager: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
				mysons: RawTransactionArgument<string>,
				domainName: RawTransactionArgument<string>,
		  ];
}
/**
 * Sets a MySoNS reverse lookup on a messaging group. The caller must have
 * `MySoNsAdmin` permission on the group. The `GroupManager` actor internally holds
 * `ObjectAdmin` to access the group UID.
 *
 * # Parameters
 *
 * - `group_manager`: Reference to the shared `GroupManager` actor
 * - `group`: Mutable reference to the `PermissionedGroup<Messaging>`
 * - `mysons`: Mutable reference to the MySoNS shared object
 * - `domain_name`: The domain name to set as reverse lookup
 * - `ctx`: Transaction context
 *
 * # Aborts
 *
 * - `ENotPermitted`: if caller doesn't have `MySoNsAdmin`
 */
export function setMySonsReverseLookup(options: SetMySonsReverseLookupOptions) {
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
	const argumentsTypes = [null, null, null, '0x1::string::String'] satisfies (string | null)[];
	const parameterNames = ['groupManager', 'group', 'mysons', 'domainName'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'set_mysons_reverse_lookup',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface UnsetMySonsReverseLookupArguments {
	groupManager: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	mysons: RawTransactionArgument<string>;
}
export interface UnsetMySonsReverseLookupOptions {
	package?: string;
	arguments:
		| UnsetMySonsReverseLookupArguments
		| [
				groupManager: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
				mysons: RawTransactionArgument<string>,
		  ];
}
/**
 * Unsets a MySoNS reverse lookup on a messaging group. The caller must have
 * `MySoNsAdmin` permission on the group. The `GroupManager` actor internally holds
 * `ObjectAdmin` to access the group UID.
 *
 * # Parameters
 *
 * - `group_manager`: Reference to the shared `GroupManager` actor
 * - `group`: Mutable reference to the `PermissionedGroup<Messaging>`
 * - `mysons`: Mutable reference to the MySoNS shared object
 * - `ctx`: Transaction context
 *
 * # Aborts
 *
 * - `ENotPermitted`: if caller doesn't have `MySoNsAdmin`
 */
export function unsetMySonsReverseLookup(options: UnsetMySonsReverseLookupOptions) {
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
	const argumentsTypes = [null, null, null] satisfies (string | null)[];
	const parameterNames = ['groupManager', 'group', 'mysons'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'unset_mysons_reverse_lookup',
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
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
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
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
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
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
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
