// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { MyDataClient, type MyDataClientOptions } from '@socialproof/mydata';
import { mysoGroups, type MySoGroupsPackageConfig } from '@socialproof/myso-groups';
import type { ClientWithCoreApi } from '@socialproof/myso/client';

import { mysoMessagingStack } from './client.js';
import { GENESIS_MESSAGING_WITNESS_TYPE } from './genesis.js';
import {
	resolveGenesisMessagingConfig,
	type ResolveGenesisMessagingConfigOptions,
} from './genesis.js';
import { MySoMessagingStackClientError } from './error.js';
import type { AttachmentsConfig } from './attachments/types.js';
import type { RelayerConfig } from './relayer/types.js';
import type { RecoveryTransport } from './recovery/transport.js';
import type {
	MySoMessagingStackEncryptionOptions,
	MySoMessagingStackClientOptions,
	MySoMessagingStackPackageConfig,
} from './types.js';

/**
 * Options for creating a fully-configured messaging groups client.
 *
 * Package configs are resolved from genesis system packages (`0x2`, `0xe110`, `0x50c1`)
 * unless explicitly overridden (tests only).
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
	 * Optional override for unit/integration tests. Production callers should omit this.
	 */
	packageConfig?: {
		messaging: MySoMessagingStackPackageConfig;
		permissionedGroups?: MySoGroupsPackageConfig;
	};

	/** Relayer transport configuration. */
	relayer: RelayerConfig;

	/** Attachment support. When omitted, messages cannot include files. */
	attachments?: AttachmentsConfig;

	/** Optional recovery transport for fetching messages from an alternative storage backend. */
	recovery?: RecoveryTransport;

	/** Optional DM block pre-check via myso-social-server. */
	blockGating?: MySoMessagingStackClientOptions<TApproveContext>['blockGating'];
}

export interface CreateMySoMessagingStackClientAsyncOptions<
	TApproveContext = void,
> extends CreateMySoMessagingStackClientOptions<TApproveContext> {
	/** GraphQL URL for genesis shared-object discovery. */
	genesis?: ResolveGenesisMessagingConfigOptions;
}

/**
 * Creates a fully-configured messaging groups client from an existing MySoClient.
 *
 * Requires `packageConfig` to be fully resolved (including shared object IDs).
 */
export function createMySoMessagingStackClient<TApproveContext = void>(
	baseClient: ClientWithCoreApi,
	options: CreateMySoMessagingStackClientOptions<TApproveContext>,
) {
	const witnessType = resolveWitnessType(options);

	const resolveMyData = (client: ClientWithCoreApi): MyDataClient =>
		isMyDataClient(options.mydata)
			? options.mydata
			: new MyDataClient({ ...options.mydata, mysoClient: client });

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
				relayer: options.relayer,
				attachments: options.attachments,
				recovery: options.recovery,
				blockGating: options.blockGating,
			}),
		);
}

/**
 * Resolves genesis shared objects, then returns a fully-configured messaging client.
 */
export async function createMySoMessagingStackClientAsync<TApproveContext = void>(
	baseClient: ClientWithCoreApi,
	options: CreateMySoMessagingStackClientAsyncOptions<TApproveContext>,
) {
	const resolved =
		options.packageConfig ??
		(await resolveGenesisMessagingConfig(baseClient, options.genesis ?? {}));

	return createMySoMessagingStackClient(baseClient, {
		...options,
		packageConfig: resolved,
	});
}

/** Duck-type check: a MyDataClient has an `encrypt` method, config options don't. */
function isMyDataClient(
	mydata: MyDataClient | Omit<MyDataClientOptions, 'mysoClient'>,
): mydata is MyDataClient {
	return typeof (mydata as MyDataClient).encrypt === 'function';
}

function resolveWitnessType(options: CreateMySoMessagingStackClientOptions<unknown>): string {
	if (options.packageConfig?.messaging) {
		return `${options.packageConfig.messaging.originalPackageId}::messaging::Messaging`;
	}
	return GENESIS_MESSAGING_WITNESS_TYPE;
}

export function assertResolvedMessagingPackageConfig(
	config: MySoMessagingStackPackageConfig,
): asserts config is MySoMessagingStackPackageConfig {
	for (const [key, value] of Object.entries(config)) {
		if (typeof value === 'string' && value.length === 0) {
			throw new MySoMessagingStackClientError(
				`Messaging package config field "${key}" is empty. ` +
					'Use createMySoMessagingStackClientAsync to resolve genesis shared objects.',
			);
		}
	}
}
