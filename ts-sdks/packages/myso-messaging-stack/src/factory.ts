// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { MyDataClient, type MyDataClientOptions } from '@socialproof/mydata';
import { mysoGroups, type MySoGroupsPackageConfig } from '@socialproof/myso-groups';
import type { ClientWithCoreApi } from '@socialproof/myso/client';

import { mysoMessagingStack } from './client.js';
import {
	TESTNET_MYSO_MESSAGING_STACK_PACKAGE_CONFIG,
	MAINNET_MYSO_MESSAGING_STACK_PACKAGE_CONFIG,
	type MySonsConfig,
} from './constants.js';
import { MySoMessagingStackClientError } from './error.js';
import type { AttachmentsConfig } from './attachments/types.js';
import type { RelayerConfig } from './relayer/types.js';
import type { RecoveryTransport } from './recovery/transport.js';
import type {
	MySoMessagingStackEncryptionOptions,
	MySoMessagingStackPackageConfig,
} from './types.js';

/**
 * Options for creating a fully-configured messaging groups client.
 *
 * For testnet/mainnet, package configs are auto-detected from the base client's network.
 * For localnet/custom deployments, explicit package configs must be provided.
 */
export interface CreateMySoMessagingStackClientOptions<TApproveContext = void> {
	/**
	 * MyData encryption layer. Either:
	 * - A pre-built `MyDataClient` instance (passed through as-is), or
	 * - MyData configuration options (sans `mysoClient`, which is injected by the factory).
	 */
	mydata: MyDataClient | Omit<MyDataClientOptions, 'mysoClient'>;

	/** Encryption configuration (session key, crypto primitives, threshold, mydata policy). */
	encryption: MySoMessagingStackEncryptionOptions<TApproveContext>;

	/**
	 * Custom package configs for localnet/devnet/custom deployments.
	 * When not provided, auto-detected from `baseClient.network` (testnet/mainnet only).
	 */
	packageConfig?: {
		/** Messaging groups package config. */
		messaging: MySoMessagingStackPackageConfig;
		/** Permissioned groups package config. Defaults to auto-detection for testnet/mainnet. */
		permissionedGroups?: MySoGroupsPackageConfig;
	};

	/** MySoNS config for reverse lookup operations (auto-detected for testnet/mainnet). */
	mysonsConfig?: MySonsConfig;

	/** Relayer transport configuration. */
	relayer: RelayerConfig;

	/** Attachment support. When omitted, messages cannot include files. */
	attachments?: AttachmentsConfig;

	/** Optional recovery transport for fetching messages from an alternative storage backend. */
	recovery?: RecoveryTransport;
}

/**
 * Creates a fully-configured messaging groups client from an existing MySoClient.
 *
 * Internally composes the `mysoGroups`, `mydata`, and `mysoMessagingStack`
 * extensions in the correct order. The returned client exposes:
 * - `client.messaging` — messaging-groups operations
 * - `client.groups` — permission management
 * - `client.mydata` — MyData encryption/decryption
 * - `client.core` — base MySo RPC methods
 *
 * @example
 * ```ts
 * import { MySoJsonRpcClient } from '@socialproof/myso/jsonRpc';
 * import { createMySoMessagingStackClient } from '@socialproof/myso-messaging-stack';
 *
 * const client = createMySoMessagingStackClient(
 *   new MySoJsonRpcClient({ url: 'https://...', network: 'testnet' }),
 *   {
 *     mydata: {
 *       serverConfigs: [
 *         { objectId: '0x...', weight: 1 },
 *         { objectId: '0x...', weight: 1 },
 *       ],
 *     },
 *     encryption: {
 *       sessionKey: { signer: myKeypair },
 *     },
 *   },
 * );
 *
 * await client.messaging.createAndShareGroup({ signer, name: 'My Group' });
 * ```
 */
export function createMySoMessagingStackClient<TApproveContext = void>(
	baseClient: ClientWithCoreApi,
	options: CreateMySoMessagingStackClientOptions<TApproveContext>,
) {
	const witnessType = resolveWitnessType(baseClient, options);

	// Resolve mydata: either pass through a pre-built MyDataClient or create one from config.
	// Done before $extend so the register callback has a concrete MyDataClient return type.
	const resolveMyData = (client: ClientWithCoreApi): MyDataClient =>
		isMyDataClient(options.mydata)
			? options.mydata
			: new MyDataClient({ ...options.mydata, mysoClient: client });

	// Two $extend calls: the first registers `groups` + `mydata` (independent of each other),
	// the second registers `messaging` (which depends on both).
	return baseClient
		.$extend(
			mysoGroups({
				witnessType,
				packageConfig: options.packageConfig?.permissionedGroups,
			}),
			{
				name: 'mydata' as const,
				register: resolveMyData,
			},
		)
		.$extend(
			mysoMessagingStack<TApproveContext>({
				packageConfig: options.packageConfig?.messaging,
				encryption: options.encryption,
				mysonsConfig: options.mysonsConfig,
				relayer: options.relayer,
				attachments: options.attachments,
				recovery: options.recovery,
			}),
		);
}

/** Duck-type check: a MyDataClient has an `encrypt` method, config options don't. */
function isMyDataClient(mydata: MyDataClient | Omit<MyDataClientOptions, 'mysoClient'>): mydata is MyDataClient {
	return typeof (mydata as MyDataClient).encrypt === 'function';
}

/**
 * Derives the `witnessType` for mysoGroups from the messaging package's
 * original package ID. For testnet/mainnet, uses the built-in constants.
 */
function resolveWitnessType(
	baseClient: ClientWithCoreApi,
	options: CreateMySoMessagingStackClientOptions<unknown>,
): string {
	if (options.packageConfig?.messaging) {
		return `${options.packageConfig.messaging.originalPackageId}::messaging::Messaging`;
	}
	switch (baseClient.network) {
		case 'testnet':
			return `${TESTNET_MYSO_MESSAGING_STACK_PACKAGE_CONFIG.originalPackageId}::messaging::Messaging`;
		case 'mainnet':
			return `${MAINNET_MYSO_MESSAGING_STACK_PACKAGE_CONFIG.originalPackageId}::messaging::Messaging`;
		default:
			throw new MySoMessagingStackClientError(
				`Cannot derive witnessType for network "${baseClient.network}". ` +
					`Provide explicit packageConfig.messaging for localnet/devnet.`,
			);
	}
}
