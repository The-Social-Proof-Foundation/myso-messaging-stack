// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { Transaction } from '@socialproof/myso/transactions';

import type { MySoMessagingStackCall } from './call.js';
import type {
	ArchiveGroupCallOptions,
	ClearGroupHandleCallOptions,
	CreateGroupCallOptions,
	InsertGroupDataCallOptions,
	LeaveCallOptions,
	RemoveGroupDataCallOptions,
	RemoveMembersAndRotateKeyCallOptions,
	RotateEncryptionKeyCallOptions,
	SetGroupHandleCallOptions,
	SetGroupNameCallOptions,
} from './types.js';

export interface MySoMessagingStackTransactionsOptions {
	call: MySoMessagingStackCall;
}

/**
 * Transaction factory methods for messaging groups.
 *
 * Each method returns a complete Transaction object ready for signing.
 * Async thunks (from group creation, key rotation) are
 * resolved at transaction `build()` time.
 *
 * @example
 * ```ts
 * // For use with dapp-kit's signAndExecuteTransaction
 * const tx = client.messaging.tx.createAndShareGroup({
 *   name: 'My Group',
 *   initialMembers: ['0x...'],
 * });
 * signAndExecuteTransaction({ transaction: tx });
 * ```
 */
export class MySoMessagingStackTransactions {
	#call: MySoMessagingStackCall;

	constructor(options: MySoMessagingStackTransactionsOptions) {
		this.#call = options.call;
	}

	// === Group Creation Functions ===

	/**
	 * Creates a Transaction that creates a new messaging group and shares both objects.
	 */
	createAndShareGroup({
		transaction = new Transaction(),
		...options
	}: CreateGroupCallOptions & { transaction?: Transaction }): Transaction {
		transaction.add(this.#call.createAndShareGroup(options));
		return transaction;
	}

	// === Encryption Functions ===

	/**
	 * Creates a Transaction that rotates the encryption key for a group.
	 */
	rotateEncryptionKey({
		transaction = new Transaction(),
		...options
	}: RotateEncryptionKeyCallOptions & { transaction?: Transaction }): Transaction {
		transaction.add(this.#call.rotateEncryptionKey(options));
		return transaction;
	}

	/**
	 * Creates a Transaction that atomically removes members and rotates the encryption key.
	 */
	removeMembersAndRotateKey({
		transaction = new Transaction(),
		...options
	}: RemoveMembersAndRotateKeyCallOptions & { transaction?: Transaction }): Transaction {
		transaction.add(this.#call.removeMembersAndRotateKey(options));
		return transaction;
	}

	// === Group Lifecycle Functions ===

	/**
	 * Creates a Transaction that permanently archives a messaging group.
	 * Requires `PermissionsAdmin` permission.
	 */
	archiveGroup({
		transaction = new Transaction(),
		...options
	}: ArchiveGroupCallOptions & { transaction?: Transaction }): Transaction {
		transaction.add(this.#call.archiveGroup(options));
		return transaction;
	}

	/**
	 * Creates a Transaction that removes the sender from a messaging group.
	 */
	leave({
		transaction = new Transaction(),
		...options
	}: LeaveCallOptions & { transaction?: Transaction }): Transaction {
		transaction.add(this.#call.leave(options));
		return transaction;
	}

	// === Metadata Functions ===

	/**
	 * Creates a Transaction that sets the group name.
	 * Requires `MetadataAdmin` permission.
	 */
	setGroupName({
		transaction = new Transaction(),
		...options
	}: SetGroupNameCallOptions & { transaction?: Transaction }): Transaction {
		transaction.add(this.#call.setGroupName(options));
		return transaction;
	}

	/**
	 * Creates a Transaction that inserts a key-value pair into the group's metadata.
	 * Requires `MetadataAdmin` permission.
	 */
	insertGroupData({
		transaction = new Transaction(),
		...options
	}: InsertGroupDataCallOptions & { transaction?: Transaction }): Transaction {
		transaction.add(this.#call.insertGroupData(options));
		return transaction;
	}

	/**
	 * Creates a Transaction that removes a key-value pair from the group's metadata.
	 * Requires `MetadataAdmin` permission.
	 */
	removeGroupData({
		transaction = new Transaction(),
		...options
	}: RemoveGroupDataCallOptions & { transaction?: Transaction }): Transaction {
		transaction.add(this.#call.removeGroupData(options));
		return transaction;
	}

	// === Group handle registry ===

	/**
	 * Registers or replaces this group's handle in `GroupHandleRegistry`.
	 * Requires `GroupHandleAdmin` permission.
	 */
	setGroupHandle({
		transaction = new Transaction(),
		...options
	}: SetGroupHandleCallOptions & { transaction?: Transaction }): Transaction {
		transaction.add(this.#call.setGroupHandle(options));
		return transaction;
	}

	/**
	 * Clears this group's handle from `GroupHandleRegistry`.
	 * Requires `GroupHandleAdmin` permission.
	 */
	clearGroupHandle({
		transaction = new Transaction(),
		...options
	}: ClearGroupHandleCallOptions & { transaction?: Transaction }): Transaction {
		transaction.add(this.#call.clearGroupHandle(options));
		return transaction;
	}
}
