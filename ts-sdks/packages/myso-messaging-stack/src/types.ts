// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MySoGroupsClient } from '@socialproof/myso-groups';
import type { MyDataClient, SessionKey } from '@socialproof/mydata';
import type { Signer } from '@socialproof/myso/cryptography';
import type { ClientWithCoreApi } from '@socialproof/myso/client';
import type { TransactionArgument } from '@socialproof/myso/transactions';

import type { AttachmentsConfig } from './attachments/types.js';
import type { CryptoPrimitives } from './encryption/crypto-primitives.js';
import type { MyDataPolicy } from './encryption/mydata-policy.js';
import type { RelayerConfig } from './relayer/types.js';
import type { RecoveryTransport } from './recovery/transport.js';

// === Package Configuration ===

/**
 * Configuration for the messaging Move package.
 * This is managed by us and provided in constants for testnet/mainnet.
 *
 * See {@link MySoGroupsPackageConfig} for a detailed explanation of
 * the `originalPackageId` / `latestPackageId` split.
 */
export type MySoMessagingStackPackageConfig = {
	/** The original (V1) package ID. Used for TypeName strings, BCS, MyData namespace, and deriveObjectID. */
	originalPackageId: string;
	/** The latest (current) package ID. Used for moveCall targets. Equals originalPackageId before any upgrade. */
	latestPackageId: string;
	/** The MessagingNamespace shared object ID */
	namespaceId: string;
	/** The Version shared object ID (used for contract upgrade version gating) */
	versionId: string;
	/** Social BlockListRegistry shared object ID (`0x50c1::block_list::BlockListRegistry`) */
	blockListRegistryId: string;
	/** Social SocialGraph shared object ID (`0x50c1::social_graph::SocialGraph`) */
	socialGraphId: string;
};

/**
 * A client that has been extended with the MySoGroupsClient and MyDataClient.
 * The messaging client requires both extensions to be present.
 *
 * The generic parameters allow consumers to use custom extension names
 * (e.g., `mysoGroups({ name: 'permissions' })` or registering
 * MyDataClient under a name other than `'mydata'`).
 */
export type MySoMessagingStackCompatibleClient<
	GroupsName extends string = 'groups',
	MyDataName extends string = 'mydata',
> = ClientWithCoreApi & {
	[K in GroupsName]: MySoGroupsClient;
} & {
	[K in MyDataName]: MyDataClient;
};

// === Session Key Configuration ===

/** Shared options for SDK-managed session key creation (Tier 1 & 2). */
interface SessionKeySharedOptions {
	/** Session key TTL in minutes (default: 10). */
	ttlMin?: number;
	/** MVR name for MyData (optional). */
	mvrName?: string;
	/** Refresh session key this many ms before expiry (default: 60_000). */
	refreshBufferMs?: number;
}

/**
 * How the SDK obtains MyData session keys. Required at client creation.
 *
 * **Tier 1 — Signer-based** (dapp-kit-next `CurrentAccountSigner`, `Keypair`, Enoki):
 * SDK derives address via `signer.toMySoAddress()`, passes signer to
 * `SessionKey.create()`, and calls `getCertificate()`. Fully automatic.
 *
 * **Tier 2 — Callback-based** (current dapp-kit without Signer abstraction):
 * Consumer provides address + signing callback. SDK calls `SessionKey.create()`
 * without signer, then `getPersonalMessage()` → `onSign()` → `setPersonalMessageSignature()`.
 *
 * **Tier 3 — Full manual control** (power users, custom persistence, exotic flows):
 * Consumer manages the entire `SessionKey` lifecycle. SDK calls `getSessionKey()`
 * whenever it needs a key.
 */
export type SessionKeyConfig =
	| ({ signer: Signer } & SessionKeySharedOptions)
	| ({
			address: string;
			onSign: (message: Uint8Array) => Promise<string>;
	  } & SessionKeySharedOptions)
	| { getSessionKey: () => Promise<SessionKey> | SessionKey };

/** Encryption-specific options for the messaging groups client. */
export interface MySoMessagingStackEncryptionOptions<TApproveContext = void> {
	/** How session keys are obtained. Required. */
	sessionKey: SessionKeyConfig;
	/** Custom crypto primitives (default: Web Crypto). */
	cryptoPrimitives?: CryptoPrimitives;
	/** MyData threshold for DEK encryption (default: 2). */
	mydataThreshold?: number;
	/**
	 * Custom MyData policy for `mydata_approve` transaction building.
	 *
	 * When not provided, {@link DefaultMyDataPolicy} is used — targeting the messaging
	 * package's `mydata_approve_reader`.
	 *
	 * Identity bytes are always `[groupId (32 bytes)][keyVersion (8 bytes LE u64)]`
	 * regardless of policy. Provide a custom policy to use a different package or
	 * access control logic (e.g., subscription-gated, NFT-gated, payment-based).
	 *
	 * The `TApproveContext` generic flows through to encrypt/decrypt operations —
	 * when `void` (default), no extra context is required.
	 */
	mydataPolicy?: MyDataPolicy<TApproveContext>;
}

export interface MySoMessagingStackClientOptions<
	TApproveContext = void,
	GroupsName extends string = 'groups',
	MyDataName extends string = 'mydata',
> {
	client: MySoMessagingStackCompatibleClient<GroupsName, MyDataName>;
	/** Name under which the MySoGroupsClient extension is registered (default: 'groups'). */
	groupsName: GroupsName;
	/** Name under which the MyDataClient extension is registered (default: 'mydata'). */
	mydataName: MyDataName;
	/**
	 * Custom package configuration for localnet, devnet, or custom deployments.
	 * When not provided, the config is auto-detected from the client's network.
	 */
	packageConfig?: MySoMessagingStackPackageConfig;
	/** Encryption configuration (required — session key config must be set at creation). */
	encryption: MySoMessagingStackEncryptionOptions<TApproveContext>;
	/** Relayer transport configuration. */
	relayer: RelayerConfig;
	/**
	 * Attachment support. When omitted, messages cannot include files,
	 * and received attachments are not resolvable.
	 */
	attachments?: AttachmentsConfig;
	/**
	 * Optional recovery transport for fetching messages from an alternative
	 * storage backend (e.g., File Storage). When provided, enables the
	 * `recoverMessages()` method on the client.
	 */
	recovery?: RecoveryTransport;
}

// === Call/Tx Options (no signer) ===

/** Options for creating a new messaging group. */
export interface CreateGroupCallOptions {
	/**
	 * UUID for deterministic address derivation of the group and encryption history.
	 * Generated internally if omitted.
	 */
	uuid?: string;
	/** Human-readable group name. */
	name: string;
	/**
	 * Addresses to grant MessagingReader permission on creation.
	 * The creator is automatically granted all permissions and should not be included.
	 */
	initialMembers?: string[];
}

/**
 * Options for rotating the encryption key.
 * The new DEK is generated and MyData-encrypted internally.
 *
 * Accepts either explicit `groupId` + `encryptionHistoryId`, or a `uuid`
 * (which derives both IDs internally).
 */
export type RotateEncryptionKeyCallOptions = GroupRef;

/** Options for sharing the objects returned by `createGroup`. */
export interface ShareGroupCallOptions {
	/** The PermissionedGroup<Messaging> result from `createGroup` */
	group: TransactionArgument;
	/** The EncryptionHistory result from `createGroup` */
	encryptionHistory: TransactionArgument;
	/** The shared `MessageLog` object (paid `MYSO` escrow holder). */
	messageLog: TransactionArgument;
}

/**
 * On-chain message log calls need the shared `MessageLog` id.
 * When the ref uses `uuid`, the log id can be derived automatically.
 * When using explicit `groupId` / `encryptionHistoryId`, pass {@link messageLogId} explicitly.
 */
export type GroupAndMessageLogRef = GroupRef & {
	messageLogId?: string;
};

/** Options for leaving a messaging group. */
export interface LeaveCallOptions {
	/** Object ID or TransactionArgument for the PermissionedGroup<Messaging> */
	groupId: string | TransactionArgument;
}

// === Top-level Imperative Options (add signer) ===

/** Options for creating a group (imperative) */
export interface CreateGroupOptions extends CreateGroupCallOptions {
	/** Signer to execute the transaction */
	signer: Signer;
}

/** Options for rotating encryption key (imperative) */
export type RotateEncryptionKeyOptions = RotateEncryptionKeyCallOptions & {
	/** Signer to execute the transaction */
	signer: Signer;
};

/** Options for leaving a group (imperative) */
export interface LeaveOptions extends LeaveCallOptions {
	/** Signer to execute the transaction */
	signer: Signer;
}

/** Options for atomically removing members and rotating the encryption key (call-level). */
export type RemoveMembersAndRotateKeyCallOptions = GroupRef & {
	/** Addresses of the members to remove. */
	members: string[];
};

/** Options for removeMembersAndRotateKey (imperative, with signer). */
export type RemoveMembersAndRotateKeyOptions = RemoveMembersAndRotateKeyCallOptions & {
	signer: Signer;
};

/** Options for archiving a group (call-level, no signer). */
export interface ArchiveGroupCallOptions {
	/** Object ID of the PermissionedGroup<Messaging> */
	groupId: string;
}

/** Options for setting the group name (call-level, no signer). */
export interface SetGroupNameCallOptions {
	/** Object ID of the PermissionedGroup<Messaging> */
	groupId: string;
	/** The new human-readable name for the group */
	name: string;
}

/** Options for inserting a key-value pair into group metadata (call-level, no signer). */
export interface InsertGroupDataCallOptions {
	/** Object ID of the PermissionedGroup<Messaging> */
	groupId: string;
	/** The metadata key */
	key: string;
	/** The metadata value */
	value: string;
}

/** Options for removing a key-value pair from group metadata (call-level, no signer). */
export interface RemoveGroupDataCallOptions {
	/** Object ID of the PermissionedGroup<Messaging> */
	groupId: string;
	/** The metadata key to remove */
	key: string;
}

/** Options for archiving a group (imperative, with signer). */
export interface ArchiveGroupOptions extends ArchiveGroupCallOptions {
	signer: Signer;
}

/** Options for setting the group name (imperative, with signer). */
export interface SetGroupNameOptions extends SetGroupNameCallOptions {
	signer: Signer;
}

/** Options for inserting group data (imperative, with signer). */
export interface InsertGroupDataOptions extends InsertGroupDataCallOptions {
	signer: Signer;
}

/** Options for removing group data (imperative, with signer). */
export interface RemoveGroupDataOptions extends RemoveGroupDataCallOptions {
	signer: Signer;
}

// === Shared Reference Types ===

/**
 * Reference to an EncryptionHistory — by object ID or by UUID (which derives the ID).
 * Exactly one must be provided.
 */
export type EncryptionHistoryRef =
	| { encryptionHistoryId: string; uuid?: never }
	| { uuid: string; encryptionHistoryId?: never };

/**
 * Reference to a group + encryption history pair — by explicit IDs or by UUID.
 *
 * Since both the `PermissionedGroup<Messaging>` and `EncryptionHistory` are derived
 * from the same UUID, providing a UUID derives both IDs internally.
 */
export type GroupRef =
	| { groupId: string; encryptionHistoryId: string; uuid?: never }
	| { uuid: string; groupId?: never; encryptionHistoryId?: never };

// === Group handle registry (separate from profile usernames) ===

/** Register or replace this group's canonical handle (call-level). */
export interface SetGroupHandleCallOptions {
	groupId: string;
	/** ASCII handle; canonicalized on-chain (lowercase `[a-z0-9_]`, length 2–50). */
	handle: string;
}

/** Clear this group's handle (call-level). */
export interface ClearGroupHandleCallOptions {
	groupId: string;
}

export interface SetGroupHandleOptions extends SetGroupHandleCallOptions {
	signer: Signer;
}

export interface ClearGroupHandleOptions extends ClearGroupHandleCallOptions {
	signer: Signer;
}

/** Options for {@link MySoMessagingStackView.lookupGroupByHandle}. */
export interface LookupGroupByHandleViewOptions {
	/** Candidate handle (canonicalization matches Move). */
	handle: string;
	/**
	 * `GroupHandleRegistry` shared object ID.
	 * When omitted, derived from `MessagingNamespace` via `derive.groupHandleRegistryId()`.
	 */
	groupHandleRegistryId?: string;
	signal?: AbortSignal;
}

// === View Options ===

/** Options for getting the encrypted key at a specific version */
export type EncryptedKeyViewOptions = EncryptionHistoryRef & {
	/** Key version (0-indexed) */
	version: bigint | number;
};
