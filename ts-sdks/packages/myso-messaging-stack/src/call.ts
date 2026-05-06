// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Transaction } from '@socialproof/myso/transactions';

import type { MySoGroupsCall } from '@socialproof/myso-groups';

import type { EnvelopeEncryption } from './encryption/envelope-encryption.js';
import * as messaging from './contracts/myso_messaging_stack/messaging.js';
import type { MySoMessagingStackDerive } from './derive.js';
import { MySoMessagingStackClientError } from './error.js';
import type { MySonsConfig } from './constants.js';
import type {
	ArchiveGroupCallOptions,
	CreateGroupCallOptions,
	InsertGroupDataCallOptions,
	LeaveCallOptions,
	MySoMessagingStackPackageConfig,
	RemoveGroupDataCallOptions,
	RemoveMembersAndRotateKeyCallOptions,
	RotateEncryptionKeyCallOptions,
	SetGroupNameCallOptions,
	SetMySonsReverseLookupCallOptions,
	ShareGroupCallOptions,
	UnsetMySonsReverseLookupCallOptions,
} from './types.js';

export interface MySoMessagingStackCallOptions {
	packageConfig: MySoMessagingStackPackageConfig;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Call only uses context-independent methods (generateGroupDEK, generateRotationDEK)
	encryption: EnvelopeEncryption<any>;
	derive: MySoMessagingStackDerive;
	/** Full Move type name for PermissionedGroup<Messaging> (resolved from groups BCS). */
	permissionedGroupTypeName: string;
	/** Full Move type name for EncryptionHistory (resolved from messaging BCS). */
	encryptionHistoryTypeName: string;
	/** MySoNS config (optional — only needed for reverse lookup operations). */
	mysonsConfig?: MySonsConfig;
	/** PermissionedGroups call layer (needed for removeMembersAndRotateKey). */
	groupsCall: MySoGroupsCall;
}

/**
 * Transaction building methods for messaging groups.
 *
 * Methods that involve encryption (group creation, key rotation)
 * return async thunks that are resolved at transaction `build()` time.
 *
 * @example
 * ```ts
 * const tx = new Transaction();
 * tx.add(client.messaging.call.createAndShareGroup({
 *   name: 'My Group',
 *   initialMembers: ['0x...', '0x...'],
 * }));
 * ```
 */
export class MySoMessagingStackCall {
	#packageConfig: MySoMessagingStackPackageConfig;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Call only uses context-independent methods (generateGroupDEK, generateRotationDEK)
	#encryption: EnvelopeEncryption<any>;
	#derive: MySoMessagingStackDerive;
	#permissionedGroupTypeName: string;
	#encryptionHistoryTypeName: string;
	#mysonsConfig?: MySonsConfig;
	#groupsCall: MySoGroupsCall;

	constructor(options: MySoMessagingStackCallOptions) {
		this.#packageConfig = options.packageConfig;
		this.#encryption = options.encryption;
		this.#derive = options.derive;
		this.#permissionedGroupTypeName = options.permissionedGroupTypeName;
		this.#encryptionHistoryTypeName = options.encryptionHistoryTypeName;
		this.#mysonsConfig = options.mysonsConfig;
		this.#groupsCall = options.groupsCall;
	}

	// === Group Creation Functions ===

	/**
	 * Creates a new messaging group with encryption.
	 * The transaction sender automatically becomes the creator with all permissions.
	 *
	 * Internally generates a UUID (if not provided), derives the group ID,
	 * and generates a MyData-encrypted DEK for the group's initial encryption key.
	 *
	 * Returns a tuple of `(PermissionedGroup<Messaging>, EncryptionHistory)`.
	 */
	createGroup(options: CreateGroupCallOptions) {
		return async (tx: Transaction) => {
			const { uuid, encryptedDek } = await this.#encryption.generateGroupDEK(options?.uuid);
			const initialMembers = this.#buildAddressVecSet(tx, options?.initialMembers ?? []);
			const groupManagerId = this.#derive.groupManagerId();

			return tx.add(
				messaging.createGroup({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						version: this.#packageConfig.versionId,
						namespace: this.#packageConfig.namespaceId,
						groupManager: groupManagerId,
						name: options.name,
						uuid,
						initialEncryptedDek: Array.from(encryptedDek),
						initialMembers,
					},
				}),
			);
		};
	}

	/**
	 * Creates a new messaging group and shares both objects.
	 * The transaction sender automatically becomes the creator with all permissions.
	 *
	 * Internally generates a UUID (if not provided), derives the group ID,
	 * and generates a MyData-encrypted DEK for the group's initial encryption key.
	 */
	createAndShareGroup(options: CreateGroupCallOptions) {
		return async (tx: Transaction) => {
			const { uuid, encryptedDek } = await this.#encryption.generateGroupDEK(options?.uuid);
			const groupManagerId = this.#derive.groupManagerId();

			return tx.add(
				messaging.createAndShareGroup({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						version: this.#packageConfig.versionId,
						namespace: this.#packageConfig.namespaceId,
						groupManager: groupManagerId,
						name: options.name,
						uuid,
						initialEncryptedDek: Array.from(encryptedDek),
						initialMembers: options?.initialMembers ?? [],
					},
				}),
			);
		};
	}

	/**
	 * Shares a PermissionedGroup<Messaging> and its EncryptionHistory.
	 * Meant to be composed with `createGroup` in the same transaction.
	 *
	 * @example
	 * ```ts
	 * const tx = new Transaction();
	 * const [group, encryptionHistory] = tx.add(client.messaging.call.createGroup({ name: 'My Group' }));
	 * tx.add(client.messaging.call.shareGroup({ group, encryptionHistory }));
	 * ```
	 */
	shareGroup(options: ShareGroupCallOptions) {
		return (tx: Transaction) => {
			tx.moveCall({
				package: '0x2',
				module: 'transfer',
				function: 'public_share_object',
				typeArguments: [this.#permissionedGroupTypeName],
				arguments: [options.group],
			});
			tx.moveCall({
				package: '0x2',
				module: 'transfer',
				function: 'public_share_object',
				typeArguments: [this.#encryptionHistoryTypeName],
				arguments: [options.encryptionHistory],
			});
		};
	}

	// === Encryption Functions ===

	/**
	 * Rotates the encryption key for a group.
	 * Requires EncryptionKeyRotator permission.
	 *
	 * Internally fetches the current key version, generates a new DEK
	 * for the next version, and MyData-encrypts it.
	 *
	 * Accepts either explicit `groupId` + `encryptionHistoryId`, or a `uuid`
	 * (which derives both IDs internally).
	 */
	rotateEncryptionKey(options: RotateEncryptionKeyCallOptions) {
		return async (tx: Transaction) => {
			const { encryptedDek, groupId, encryptionHistoryId } =
				await this.#encryption.generateRotationDEK(options);

			return tx.add(
				messaging.rotateEncryptionKey({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						version: this.#packageConfig.versionId,
						encryptionHistory: encryptionHistoryId,
						group: groupId,
						newEncryptedDek: Array.from(encryptedDek),
					},
				}),
			);
		};
	}

	/**
	 * Atomically removes one or more members and rotates the encryption key.
	 *
	 * Composes `removeMember` (from permissioned-groups) for each member and a
	 * single `rotateEncryptionKey` into one PTB so that removed members cannot
	 * decrypt new messages.
	 */
	removeMembersAndRotateKey(options: RemoveMembersAndRotateKeyCallOptions) {
		return async (tx: Transaction) => {
			const { groupId, encryptionHistoryId } = this.#derive.resolveGroupRef(options);

			// 1. Remove each member.
			for (const member of options.members) {
				tx.add(this.#groupsCall.removeMember({ groupId, member }));
			}

			// 2. Generate new DEK and rotate (once).
			const { encryptedDek } = await this.#encryption.generateRotationDEK({
				groupId,
				encryptionHistoryId,
			});

			tx.add(
				messaging.rotateEncryptionKey({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						version: this.#packageConfig.versionId,
						encryptionHistory: encryptionHistoryId,
						group: groupId,
						newEncryptedDek: Array.from(encryptedDek),
					},
				}),
			);
		};
	}

	// === Group Lifecycle Functions ===

	/**
	 * Permanently archives a messaging group.
	 * Requires `PermissionsAdmin` permission.
	 *
	 * Pauses the group and burns the `UnpauseCap`, making it impossible to unpause.
	 * After this call, `is_paused()` returns `true` on-chain and all mutations are blocked.
	 */
	archiveGroup(options: ArchiveGroupCallOptions) {
		return (tx: Transaction) => {
			return tx.add(
				messaging.archiveGroup({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						version: this.#packageConfig.versionId,
						group: options.groupId,
					},
				}),
			);
		};
	}

	/**
	 * Removes the transaction sender from a messaging group.
	 *
	 * Internally derives the `GroupLeaver` singleton ID from the namespace.
	 * No caller-provided `groupLeaverId` is needed.
	 *
	 * @throws if the caller is not a member, or is the last `PermissionsAdmin`
	 */
	leave(options: LeaveCallOptions) {
		return (tx: Transaction) => {
			const groupLeaverId = this.#derive.groupLeaverId();
			return tx.add(
				messaging.leave({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						groupLeaver: groupLeaverId,
						group: options.groupId,
					},
				}),
			);
		};
	}

	// === Metadata Functions ===

	/**
	 * Sets the group name.
	 * Requires `MetadataAdmin` permission.
	 */
	setGroupName(options: SetGroupNameCallOptions) {
		return (tx: Transaction) => {
			const groupManagerId = this.#derive.groupManagerId();
			return tx.add(
				messaging.setGroupName({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						groupManager: groupManagerId,
						group: options.groupId,
						name: options.name,
					},
				}),
			);
		};
	}

	/**
	 * Inserts a key-value pair into the group's metadata data map.
	 * Requires `MetadataAdmin` permission.
	 */
	insertGroupData(options: InsertGroupDataCallOptions) {
		return (tx: Transaction) => {
			const groupManagerId = this.#derive.groupManagerId();
			return tx.add(
				messaging.insertGroupData({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						groupManager: groupManagerId,
						group: options.groupId,
						key: options.key,
						value: options.value,
					},
				}),
			);
		};
	}

	/**
	 * Removes a key-value pair from the group's metadata data map.
	 * Requires `MetadataAdmin` permission.
	 */
	removeGroupData(options: RemoveGroupDataCallOptions) {
		return (tx: Transaction) => {
			const groupManagerId = this.#derive.groupManagerId();
			return tx.add(
				messaging.removeGroupData({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						groupManager: groupManagerId,
						group: options.groupId,
						key: options.key,
					},
				}),
			);
		};
	}

	// === MySoNS Reverse Lookup Functions ===

	/**
	 * Sets a MySoNS reverse lookup on a messaging group.
	 * Requires `MySoNsAdmin` permission on the group.
	 *
	 * Internally derives the `GroupManager` singleton ID and uses the
	 * configured MySoNS shared object.
	 *
	 * @throws {MySoMessagingStackClientError} if MySoNS config was not provided
	 */
	setMySonsReverseLookup(options: SetMySonsReverseLookupCallOptions) {
		const mysonsConfig = this.#requireMySonsConfig();
		return (tx: Transaction) => {
			const groupManagerId = this.#derive.groupManagerId();
			return tx.add(
				messaging.setMySonsReverseLookup({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						groupManager: groupManagerId,
						group: options.groupId,
						mysons: mysonsConfig.mysonsObjectId,
						domainName: options.domainName,
					},
				}),
			);
		};
	}

	/**
	 * Unsets a MySoNS reverse lookup on a messaging group.
	 * Requires `MySoNsAdmin` permission on the group.
	 *
	 * @throws {MySoMessagingStackClientError} if MySoNS config was not provided
	 */
	unsetMySonsReverseLookup(options: UnsetMySonsReverseLookupCallOptions) {
		const mysonsConfig = this.#requireMySonsConfig();
		return (tx: Transaction) => {
			const groupManagerId = this.#derive.groupManagerId();
			return tx.add(
				messaging.unsetMySonsReverseLookup({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						groupManager: groupManagerId,
						group: options.groupId,
						mysons: mysonsConfig.mysonsObjectId,
					},
				}),
			);
		};
	}

	// === Private Helpers ===

	#requireMySonsConfig(): MySonsConfig {
		if (!this.#mysonsConfig) {
			throw new MySoMessagingStackClientError(
				'MySoNS config is required for reverse lookup operations. ' +
					'Provide mysonsConfig when creating the messaging groups client, ' +
					'or use a network (testnet/mainnet) that has a default config.',
			);
		}
		return this.#mysonsConfig;
	}

	/**
	 * Build a VecSet<address> from an array of address strings.
	 * Used by createGroup which still takes VecSet<address>.
	 */
	#buildAddressVecSet(tx: Transaction, members: string[]) {
		if (members.length === 0) {
			return tx.moveCall({
				package: '0x2',
				module: 'vec_set',
				function: 'empty',
				arguments: [],
				typeArguments: ['address'],
			});
		}

		const addressVec = tx.makeMoveVec({
			type: 'address',
			elements: members.map((member) => tx.pure.address(member)),
		});

		return tx.moveCall({
			package: '0x2',
			module: 'vec_set',
			function: 'from_keys',
			arguments: [addressVec],
			typeArguments: ['address'],
		});
	}
}
