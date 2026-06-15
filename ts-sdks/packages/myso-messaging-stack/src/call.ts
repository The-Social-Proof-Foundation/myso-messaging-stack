// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Transaction } from '@socialproof/myso/transactions';

import type { MySoGroupsCall } from '@socialproof/myso-groups';

import type { EnvelopeEncryption } from './encryption/envelope-encryption.js';
import * as messaging from './contracts/messaging/messaging.js';
import * as paidMessagingPolicy from './contracts/messaging/paid_messaging_policy.js';
import type { MySoMessagingStackDerive } from './derive.js';
import { MySoMessagingStackClientError } from './error.js';
import type {
	ArchiveGroupCallOptions,
	ClearGroupHandleCallOptions,
	CreateGroupCallOptions,
	GroupAndMessageLogRef,
	InsertGroupDataCallOptions,
	LeaveCallOptions,
	MySoMessagingStackPackageConfig,
	RemoveGroupDataCallOptions,
	RemoveMembersAndRotateKeyCallOptions,
	RotateEncryptionKeyCallOptions,
	SetGroupNameCallOptions,
	SetGroupHandleCallOptions,
	ShareGroupCallOptions,
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
	/** Full Move type name for the shared `MessageLog` object (`...::message_log::MessageLog`). */
	messageLogTypeName: string;
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
	#messageLogTypeName: string;
	#groupsCall: MySoGroupsCall;

	constructor(options: MySoMessagingStackCallOptions) {
		this.#packageConfig = options.packageConfig;
		this.#encryption = options.encryption;
		this.#derive = options.derive;
		this.#permissionedGroupTypeName = options.permissionedGroupTypeName;
		this.#encryptionHistoryTypeName = options.encryptionHistoryTypeName;
		this.#messageLogTypeName = options.messageLogTypeName;
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
	 * Returns a tuple of `(PermissionedGroup<Messaging>, EncryptionHistory, MessageLog)`.
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
						blockList: this.#packageConfig.blockListRegistryId,
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
						blockList: this.#packageConfig.blockListRegistryId,
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
	 * Shares a PermissionedGroup<Messaging>, its EncryptionHistory, and the group's MessageLog.
	 * Meant to be composed with `createGroup` in the same transaction.
	 *
	 * @example
	 * ```ts
	 * const tx = new Transaction();
	 * const [group, encryptionHistory, messageLog] = tx.add(client.messaging.call.createGroup({ name: 'My Group' }));
	 * tx.add(client.messaging.call.shareGroup({ group, encryptionHistory, messageLog }));
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
			tx.moveCall({
				package: '0x2',
				module: 'transfer',
				function: 'public_share_object',
				typeArguments: [this.#messageLogTypeName],
				arguments: [options.messageLog],
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

	// === On-chain paid MYSO escrow (MessageLog shared object) ===

	#resolveGroupAndLog(ref: GroupAndMessageLogRef): { groupId: string; messageLogId: string } {
		const resolved = this.#derive.resolveGroupRef(ref);
		const messageLogId = ref.messageLogId ?? resolved.messageLogId;
		if (!messageLogId) {
			throw new MySoMessagingStackClientError(
				'messageLogId is required when using explicit groupId/encryptionHistoryId without uuid.',
			);
		}
		return { groupId: resolved.groupId, messageLogId };
	}

	#byteVec(v: Uint8Array | number[]): number[] {
		return Array.from(v instanceof Uint8Array ? v : v);
	}

	sendPaidMessageDigest(
		options: GroupAndMessageLogRef & {
			recipient: string;
			payment: string;
			escrowAmount: number | bigint;
			dedupeKey: Uint8Array | number[];
			nonce: number | bigint;
		},
	) {
		return (tx: Transaction) => {
			const { groupId, messageLogId } = this.#resolveGroupAndLog(options);
			return tx.add(
				messaging.sendPaidMessageDigest({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						version: this.#packageConfig.versionId,
						group: groupId,
						log: messageLogId,
						paidRegistry: this.#derive.paidMessagingRegistryId(),
						socialGraph: this.#packageConfig.socialGraphId,
						blockList: this.#packageConfig.blockListRegistryId,
						groupManager: this.#derive.groupManagerId(),
						recipient: options.recipient,
						payment: options.payment,
						escrowAmount: options.escrowAmount,
						dedupeKey: this.#byteVec(options.dedupeKey),
						nonce: options.nonce,
					},
				}),
			);
		};
	}

	setPaidMessagingPolicy(options: { enabled: boolean; minCost: number | bigint | null }) {
		return (tx: Transaction) =>
			tx.add(
				paidMessagingPolicy.setPaidMessagingPolicy({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						registry: this.#derive.paidMessagingRegistryId(),
						enabled: options.enabled,
						minCost: options.minCost,
					},
				}),
			);
	}

	replyToPaidMessageClaimCoin(
		options: GroupAndMessageLogRef & {
			paidMsgSeq: number | bigint;
			charCount: number;
			dedupeKey: Uint8Array | number[];
			nonce: number | bigint;
		},
	) {
		return (tx: Transaction) => {
			const { groupId, messageLogId } = this.#resolveGroupAndLog(options);
			return tx.add(
				messaging.replyToPaidMessageClaimCoin({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						version: this.#packageConfig.versionId,
						group: groupId,
						log: messageLogId,
						blockList: this.#packageConfig.blockListRegistryId,
						paidMsgSeq: options.paidMsgSeq,
						charCount: options.charCount,
						dedupeKey: this.#byteVec(options.dedupeKey),
						nonce: options.nonce,
					},
				}),
			);
		};
	}

	replyToPaidMessageClaimSettled(
		options: GroupAndMessageLogRef & {
			paidMsgSeq: number | bigint;
			charCount: number;
			dedupeKey: Uint8Array | number[];
			nonce: number | bigint;
			platformFeeRecipient: string;
			ecosystemFeeRecipient: string;
		},
	) {
		return (tx: Transaction) => {
			const { groupId, messageLogId } = this.#resolveGroupAndLog(options);
			return tx.add(
				messaging.replyToPaidMessageClaimSettled({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						version: this.#packageConfig.versionId,
						group: groupId,
						log: messageLogId,
						blockList: this.#packageConfig.blockListRegistryId,
						paidMsgSeq: options.paidMsgSeq,
						charCount: options.charCount,
						dedupeKey: this.#byteVec(options.dedupeKey),
						nonce: options.nonce,
						platformFeeRecipient: options.platformFeeRecipient,
						ecosystemFeeRecipient: options.ecosystemFeeRecipient,
					},
				}),
			);
		};
	}

	refundPaidEscrow(
		options: GroupAndMessageLogRef & {
			paidMsgSeq: number | bigint;
		},
	) {
		return (tx: Transaction) => {
			const { groupId, messageLogId } = this.#resolveGroupAndLog(options);
			return tx.add(
				messaging.refundPaidEscrow({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						version: this.#packageConfig.versionId,
						group: groupId,
						log: messageLogId,
						blockList: this.#packageConfig.blockListRegistryId,
						paidMsgSeq: options.paidMsgSeq,
					},
				}),
			);
		};
	}

	// === Group handle registry (separate from profile usernames) ===

	/**
	 * Registers or replaces the canonical handle for this group in [`GroupHandleRegistry`].
	 * Requires `GroupHandleAdmin`.
	 */
	setGroupHandle(options: SetGroupHandleCallOptions) {
		return (tx: Transaction) => {
			const registryId = this.#derive.groupHandleRegistryId();
			return tx.add(
				messaging.setGroupHandle({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						version: this.#packageConfig.versionId,
						registry: registryId,
						group: options.groupId,
						handle: options.handle,
					},
				}),
			);
		};
	}

	/** Clears this group's handle from the registry. Requires `GroupHandleAdmin`. */
	clearGroupHandle(options: ClearGroupHandleCallOptions) {
		return (tx: Transaction) => {
			const registryId = this.#derive.groupHandleRegistryId();
			return tx.add(
				messaging.clearGroupHandle({
					package: this.#packageConfig.latestPackageId,
					arguments: {
						version: this.#packageConfig.versionId,
						registry: registryId,
						group: options.groupId,
					},
				}),
			);
		};
	}

	// === Private Helpers ===

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
