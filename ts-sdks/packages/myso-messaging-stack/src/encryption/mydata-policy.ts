// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { bcs } from '@socialproof/myso/bcs';
import type { Transaction, TransactionResult } from '@socialproof/myso/transactions';
import { isValidMySoAddress } from '@socialproof/myso/utils';

import { mydataApproveReader } from '../contracts/messaging/mydata_policies.js';

/**
 * Defines how MyData decryption access control works for a messaging group.
 *
 * Bundles two concerns:
 * 1. Which package ID to use for MyData encryption namespace
 * 2. How to build a `mydata_approve` transaction thunk for `mydata.decrypt()`
 *
 * Identity bytes are always `[groupId (32 bytes)][keyVersion (8 bytes LE u64)]` —
 * this is enforced by the SDK and not customizable. Custom `mydata_approve` functions
 * receive these standard identity bytes and validate them alongside their own checks.
 *
 * The default implementation ({@link DefaultMyDataPolicy}) targets
 * `messaging::mydata_policies::mydata_approve_reader`.
 *
 * The optional `TApproveContext` generic allows custom policies to require
 * additional runtime context (e.g., subscription ID, service ID) that is
 * passed through at encrypt/decrypt time. When `TApproveContext` is `void`
 * (the default), no extra parameter is required — keeping the API transparent.
 *
 * @example
 * ```ts
 * // Custom subscription-gated policy
 * interface SubContext { serviceId: string; subscriptionId: string }
 *
 * const policy: MyDataPolicy<SubContext> = {
 *   packageId: myPackageId,
 *   mydataApproveThunk(identityBytes, groupId, encHistId, context) {
 *     return (tx) => tx.moveCall({
 *       target: `${myPackageId}::custom_mydata_policy::mydata_approve`,
 *       typeArguments: ['0x2::myso::MYSO'],
 *       arguments: [
 *         tx.pure.vector('u8', Array.from(identityBytes)),
 *         tx.object(context.subscriptionId),
 *         tx.object(context.serviceId),
 *         tx.object(groupId),
 *         tx.object(encHistId),
 *         tx.object('0x6'),
 *       ],
 *     });
 *   },
 * };
 * ```
 */
export interface MyDataPolicy<TApproveContext = void> {
	/** Original (V1) package ID passed to `mydata.encrypt()` as the encryption namespace. */
	readonly packageId: string;
	/** Optional caller binding, checked even when the DEK is already cached. */
	assertSessionIdentity?(identity: { address: string; packageId: string }): void;

	/**
	 * Build a `mydata_approve` transaction thunk for MyData decryption.
	 * The returned thunk is later added to a transaction and built into
	 * the `txBytes` that MyData key servers dry-run for access control.
	 *
	 * This is called lazily at decrypt time — implement dynamic routing here
	 * for multiple access paths (e.g., check if user has subscription, else
	 * build payment tx).
	 *
	 * @param identityBytes - The identity bytes extracted from the EncryptedObject
	 * @param groupId - The PermissionedGroup object ID
	 * @param encryptionHistoryId - The EncryptionHistory object ID
	 * @param context - Additional runtime context (only when TApproveContext is not void)
	 * @returns Transaction thunk compatible with `tx.add()`
	 */
	mydataApproveThunk(
		identityBytes: Uint8Array,
		groupId: string,
		encryptionHistoryId: string,
		...context: TApproveContext extends void ? [] : [context: TApproveContext]
	): (tx: Transaction) => TransactionResult;
}

export interface AgentReaderPolicyOptions {
	originalPackageId: string;
	latestPackageId: string;
	versionId: string;
	platformId: string;
	memoryConfigId: string;
	memoryAccountId: string;
	/** Derived address of the exact acting agent, not its owner's wallet. */
	agentDerivedAddress: string;
}

function policyAddress(value: string): string {
	if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new Error('Invalid agent reader policy address');
	return `0x${value.slice(2).toLowerCase().padStart(64, '0')}`;
}

/** Uses the existing native CAP_MESSAGE_READ/ancestry/expiry/platform reader gate.
 * Keep this policy's deployment/account/agent configuration outside tool inputs.
 * Cached keys still require caller-side live authorization and invalidation. */
export class AgentMyDataReaderPolicy implements MyDataPolicy<void> {
	readonly packageId: string;
	readonly #options: AgentReaderPolicyOptions;

	constructor(options: AgentReaderPolicyOptions) {
		this.#options = {
			originalPackageId: policyAddress(options.originalPackageId),
			latestPackageId: policyAddress(options.latestPackageId),
			versionId: policyAddress(options.versionId),
			platformId: policyAddress(options.platformId),
			memoryConfigId: policyAddress(options.memoryConfigId),
			memoryAccountId: policyAddress(options.memoryAccountId),
			agentDerivedAddress: policyAddress(options.agentDerivedAddress),
		};
		this.packageId = this.#options.originalPackageId;
	}

	assertSessionIdentity(identity: { address: string; packageId: string }): void {
		if (
			policyAddress(identity.address) !== this.#options.agentDerivedAddress ||
			policyAddress(identity.packageId) !== this.packageId
		) {
			throw new Error('MyData session does not belong to the configured room agent');
		}
	}

	mydataApproveThunk(
		identityBytes: Uint8Array,
		groupId: string,
		encryptionHistoryId: string,
	): (tx: Transaction) => TransactionResult {
		const decoded = DefaultMyDataPolicy.decodeIdentity(identityBytes);
		if (decoded.groupId !== policyAddress(groupId))
			throw new Error('Room encryption identity mismatch');
		const group = policyAddress(groupId);
		const history = policyAddress(encryptionHistoryId);
		const options = this.#options;
		// Copy before returning the asynchronous transaction thunk.
		const identity = Array.from(identityBytes);
		return (tx) =>
			tx.moveCall({
				package: options.latestPackageId,
				module: 'mydata_policies',
				function: 'mydata_approve_agent_reader',
				arguments: [
					tx.pure.vector('u8', identity),
					tx.object(options.versionId),
					tx.object(group),
					tx.object(history),
					tx.object(options.platformId),
					tx.object(options.memoryConfigId),
					tx.object(options.memoryAccountId),
					tx.object('0x6'),
				],
			});
	}
}

// === Default Identity Encoding ===

/** Length of the default MyData identity bytes: 32 (groupId) + 8 (keyVersion LE u64). */
const DEFAULT_IDENTITY_BYTES_LENGTH = 40;

/** BCS layout for the default identity bytes: `[Address (32 bytes)][u64 LE (8 bytes)]`. */
const DefaultIdentityBcs = bcs.struct('DefaultMyDataIdentity', {
	groupId: bcs.Address,
	keyVersion: bcs.u64(),
});

/**
 * Default mydata policy using the messaging package's `mydata_approve_reader`.
 *
 * Identity format: `[groupId (32 bytes)][keyVersion (8 bytes LE u64)]`
 *
 * This is used automatically when no custom `mydataPolicy` is provided
 * in {@link MySoMessagingStackEncryptionOptions}.
 */
export class DefaultMyDataPolicy implements MyDataPolicy<void> {
	readonly packageId: string;
	readonly #latestPackageId: string;
	readonly #versionId: string;

	constructor(originalPackageId: string, latestPackageId: string, versionId: string) {
		this.packageId = originalPackageId;
		this.#latestPackageId = latestPackageId;
		this.#versionId = versionId;
	}

	/**
	 * Encode groupId + keyVersion into the 40-byte identity format.
	 *
	 * Layout: `[group_id (32 bytes)][key_version (8 bytes LE u64)]`
	 *
	 * @param groupId - 0x-prefixed hex MySo address (validated)
	 * @param keyVersion - Encryption key version (0-indexed)
	 * @throws if `groupId` is not a valid MySo address
	 */
	static encodeIdentity(groupId: string, keyVersion: bigint): Uint8Array {
		if (!isValidMySoAddress(groupId)) {
			throw new Error(`Invalid groupId: expected a valid MySo address, got "${groupId}"`);
		}
		return DefaultIdentityBcs.serialize({ groupId, keyVersion }).toBytes();
	}

	/**
	 * Decode 40 identity bytes back into groupId and keyVersion.
	 *
	 * @throws if `bytes.length !== 40`
	 */
	static decodeIdentity(bytes: Uint8Array): { groupId: string; keyVersion: bigint } {
		if (bytes.length !== DEFAULT_IDENTITY_BYTES_LENGTH) {
			throw new Error(
				`Invalid identity bytes length: expected ${DEFAULT_IDENTITY_BYTES_LENGTH}, got ${bytes.length}`,
			);
		}
		const parsed = DefaultIdentityBcs.parse(bytes);
		return { groupId: parsed.groupId, keyVersion: BigInt(parsed.keyVersion) };
	}

	mydataApproveThunk(
		identityBytes: Uint8Array,
		groupId: string,
		encryptionHistoryId: string,
	): (tx: Transaction) => TransactionResult {
		return mydataApproveReader({
			package: this.#latestPackageId,
			arguments: {
				id: Array.from(identityBytes),
				version: this.#versionId,
				group: groupId,
				encryptionHistory: encryptionHistoryId,
			},
		});
	}
}

export interface PrincipalOversightPolicyOptions {
	originalPackageId: string;
	latestPackageId: string;
	versionId: string;
	memoryAccountId: string;
	agentDerivedAddress: string;
}

/**
 * Principal MyData policy using `mydata_approve_reader_with_oversight`.
 *
 * Allows the human owner to decrypt agent-associated groups when they hold
 * read-only oversight (principal has admin + agent has MessagingReader).
 */
export class PrincipalMyDataOversightPolicy implements MyDataPolicy<void> {
	readonly packageId: string;
	readonly #latestPackageId: string;
	readonly #versionId: string;
	readonly #memoryAccountId: string;
	readonly #agentDerivedAddress: string;

	constructor(options: PrincipalOversightPolicyOptions) {
		this.packageId = options.originalPackageId;
		this.#latestPackageId = options.latestPackageId;
		this.#versionId = options.versionId;
		this.#memoryAccountId = options.memoryAccountId;
		this.#agentDerivedAddress = options.agentDerivedAddress;
	}

	mydataApproveThunk(
		identityBytes: Uint8Array,
		groupId: string,
		encryptionHistoryId: string,
	): (tx: Transaction) => TransactionResult {
		const packageAddress = this.#latestPackageId;
		return (tx: Transaction) =>
			tx.moveCall({
				package: packageAddress,
				module: 'mydata_policies',
				function: 'mydata_approve_reader_with_oversight',
				arguments: [
					tx.pure.vector('u8', Array.from(identityBytes)),
					tx.object(this.#versionId),
					tx.object(groupId),
					tx.object(encryptionHistoryId),
					tx.object(this.#memoryAccountId),
					tx.pure.address(this.#agentDerivedAddress),
				],
			});
	}
}
