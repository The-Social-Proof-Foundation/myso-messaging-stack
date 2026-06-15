/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/

/**
 * Module: encryption_history
 *
 * Internal module for envelope encryption key management. Stores encrypted DEKs
 * (Data Encryption Keys) with version tracking for key rotation.
 *
 * `EncryptionHistory` is a derived object from `MessagingNamespace`, enabling
 * deterministic address derivation for MyData encryption namespacing.
 *
 * Uses client-provided UUIDs for derivation, enabling predictable group IDs for
 * single-transaction encryption with MyData.
 *
 * All public entry points are in the `messaging` module:
 *
 * - `messaging::create_group` - creates group with encryption
 * - `messaging::rotate_encryption_key` - rotates keys
 */

import {
	MoveTuple,
	MoveStruct,
	normalizeMoveArguments,
	type RawTransactionArgument,
} from '../utils/index.js';
import { bcs } from '@socialproof/myso/bcs';
import { type Transaction } from '@socialproof/myso/transactions';
import * as table_vec from './deps/myso/table_vec.js';
const $moduleName = '@local-pkg/messaging::encryption_history';
export const EncryptionHistoryTag = new MoveTuple({
	name: `${$moduleName}::EncryptionHistoryTag`,
	fields: [bcs.string()],
});
export const PermissionedGroupTag = new MoveTuple({
	name: `${$moduleName}::PermissionedGroupTag`,
	fields: [bcs.string()],
});
export const EncryptionKeyRotator = new MoveTuple({
	name: `${$moduleName}::EncryptionKeyRotator`,
	fields: [bcs.bool()],
});
export const EncryptionHistory = new MoveStruct({
	name: `${$moduleName}::EncryptionHistory`,
	fields: {
		id: bcs.Address,
		/** Associated `PermissionedGroup<Messaging>` ID. */
		group_id: bcs.Address,
		/** UUID used for derivation. */
		uuid: bcs.string(),
		/**
		 * Versioned encrypted DEKs. Index = version number. Each entry is MyData
		 * `EncryptedObject` bytes.
		 */
		encrypted_keys: table_vec.TableVec,
	},
});
export const EncryptionHistoryCreated = new MoveStruct({
	name: `${$moduleName}::EncryptionHistoryCreated`,
	fields: {
		/** ID of the created EncryptionHistory. */
		encryption_history_id: bcs.Address,
		/** ID of the associated PermissionedGroup<Messaging>. */
		group_id: bcs.Address,
		/** UUID used for derivation. */
		uuid: bcs.string(),
		/** Initial encrypted DEK bytes. */
		initial_encrypted_dek: bcs.vector(bcs.u8()),
	},
});
export const EncryptionKeyRotated = new MoveStruct({
	name: `${$moduleName}::EncryptionKeyRotated`,
	fields: {
		/** ID of the EncryptionHistory. */
		encryption_history_id: bcs.Address,
		/** ID of the associated PermissionedGroup<Messaging>. */
		group_id: bcs.Address,
		/** New key version (0-indexed). */
		new_key_version: bcs.u64(),
		/** New encrypted DEK bytes. */
		new_encrypted_dek: bcs.vector(bcs.u8()),
	},
});
export interface GroupIdArguments {
	self: RawTransactionArgument<string>;
}
export interface GroupIdOptions {
	package?: string;
	arguments: GroupIdArguments | [self: RawTransactionArgument<string>];
}
/**
 * Returns the associated `PermissionedGroup<Messaging>` ID.
 *
 * # Parameters
 *
 * - `self`: Reference to the EncryptionHistory
 *
 * # Returns
 *
 * The group ID.
 */
export function groupId(options: GroupIdOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['self'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'encryption_history',
			function: 'group_id',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface UuidArguments {
	self: RawTransactionArgument<string>;
}
export interface UuidOptions {
	package?: string;
	arguments: UuidArguments | [self: RawTransactionArgument<string>];
}
/**
 * Returns the UUID used for derivation.
 *
 * # Parameters
 *
 * - `self`: Reference to the EncryptionHistory
 *
 * # Returns
 *
 * The UUID string.
 */
export function uuid(options: UuidOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['self'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'encryption_history',
			function: 'uuid',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface CurrentKeyVersionArguments {
	self: RawTransactionArgument<string>;
}
export interface CurrentKeyVersionOptions {
	package?: string;
	arguments: CurrentKeyVersionArguments | [self: RawTransactionArgument<string>];
}
/**
 * Returns the current key version (0-indexed).
 *
 * # Parameters
 *
 * - `self`: Reference to the EncryptionHistory
 *
 * # Returns
 *
 * The current (latest) key version.
 */
export function currentKeyVersion(options: CurrentKeyVersionOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['self'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'encryption_history',
			function: 'current_key_version',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface EncryptedKeyArguments {
	self: RawTransactionArgument<string>;
	version: RawTransactionArgument<number | bigint>;
}
export interface EncryptedKeyOptions {
	package?: string;
	arguments:
		| EncryptedKeyArguments
		| [self: RawTransactionArgument<string>, version: RawTransactionArgument<number | bigint>];
}
/**
 * Returns the encrypted DEK for a specific version.
 *
 * # Parameters
 *
 * - `self`: Reference to the EncryptionHistory
 * - `version`: The key version to retrieve (0-indexed)
 *
 * # Returns
 *
 * Reference to the encrypted DEK bytes.
 *
 * # Aborts
 *
 * - `EKeyVersionNotFound`: if the version doesn't exist
 */
export function encryptedKey(options: EncryptedKeyOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null, 'u64'] satisfies (string | null)[];
	const parameterNames = ['self', 'version'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'encryption_history',
			function: 'encrypted_key',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface CurrentEncryptedKeyArguments {
	self: RawTransactionArgument<string>;
}
export interface CurrentEncryptedKeyOptions {
	package?: string;
	arguments: CurrentEncryptedKeyArguments | [self: RawTransactionArgument<string>];
}
/**
 * Returns the encrypted DEK for the current (latest) version.
 *
 * # Parameters
 *
 * - `self`: Reference to the EncryptionHistory
 *
 * # Returns
 *
 * Reference to the current encrypted DEK bytes.
 */
export function currentEncryptedKey(options: CurrentEncryptedKeyOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['self'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'encryption_history',
			function: 'current_encrypted_key',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
