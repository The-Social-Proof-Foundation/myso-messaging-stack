// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MyDataClient, MyDataClientOptions, MyDataCompatibleClient } from '@socialproof/mydata';
import { SessionKey } from '@socialproof/mydata';
import {
	createMySoMessagingStackClient as createClient,
	type RelayerConfig,
	type RelayerTransport,
	type MyDataPolicy,
} from '@socialproof/myso-messaging-stack';
import type { MySoClientTypes } from '@socialproof/myso/client';
import type { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';

import { createMockMyDataClient } from './mydata-mock/index.js';
import { createMySoClient, type MySoTransport } from './create-myso-client.js';

/** No-op transport for integration tests that only exercise on-chain operations. */
const noopTransport: RelayerTransport = {
	sendMessage: () => {
		throw new Error('noopTransport: sendMessage not implemented');
	},
	fetchMessages: () => {
		throw new Error('noopTransport: fetchMessages not implemented');
	},
	fetchMessage: () => {
		throw new Error('noopTransport: fetchMessage not implemented');
	},
	updateMessage: () => {
		throw new Error('noopTransport: updateMessage not implemented');
	},
	deleteMessage: () => {
		throw new Error('noopTransport: deleteMessage not implemented');
	},
	subscribe: () => {
		throw new Error('noopTransport: subscribe not implemented');
	},
	listGroupReactions: () => {
		throw new Error('noopTransport: listGroupReactions not implemented');
	},
	postGroupReaction: () => {
		throw new Error('noopTransport: postGroupReaction not implemented');
	},
	listGroupPins: () => {
		throw new Error('noopTransport: listGroupPins not implemented');
	},
	setGroupPin: () => {
		throw new Error('noopTransport: setGroupPin not implemented');
	},
	getGroupReceipts: () => {
		throw new Error('noopTransport: getGroupReceipts not implemented');
	},
	postGroupReceipts: () => {
		throw new Error('noopTransport: postGroupReceipts not implemented');
	},
	disconnect: () => {},
};

export interface CreateMySoMessagingStackClientOptions<TApproveContext = void> {
	url: string;
	network: MySoClientTypes.Network;
	transport?: MySoTransport;
	permissionedGroupsPackageId: string;
	messagingPackageId: string;
	namespaceId: string;
	versionId: string;
	keypair: Ed25519Keypair;
	mydataPolicy?: MyDataPolicy<TApproveContext>;
	/**
	 * Relayer configuration. When provided, the client uses a real relayer transport
	 * (e.g. HTTPRelayerTransport for E2E tests). When omitted, a noop transport is used
	 * (suitable for integration tests that only exercise on-chain operations).
	 */
	relayer?: RelayerConfig;
	/**
	 * MyData configuration override. When provided, uses a real MyDataClient
	 * (e.g. for testnet E2E with real key servers). When omitted, a mock MyDataClient is used
	 * (suitable for localnet tests).
	 */
	mydata?: MyDataClient | Omit<MyDataClientOptions, 'mysoClient'>;
}

/**
 * Creates a fully extended MySo client with `mysoGroups`, `mydata`,
 * and `mysoMessagingStack` extensions.
 *
 * By default uses a mock MyDataClient and noop relayer transport (suitable for
 * integration tests that only exercise on-chain operations). Pass `mydata` and/or
 * `relayer` options to use real implementations (e.g. for E2E tests with a real
 * relayer and testnet key servers).
 */
export function createMySoMessagingStackClient<TApproveContext = void>(
	options: CreateMySoMessagingStackClientOptions<TApproveContext>,
) {
	const {
		url,
		network,
		transport,
		permissionedGroupsPackageId,
		messagingPackageId,
		namespaceId,
		versionId,
		keypair,
		mydataPolicy,
		relayer,
		mydata,
	} = options;

	const baseClient = createMySoClient({
		url,
		network,
		transport,
		mvr: {
			overrides: {
				packages: {
					'@local-pkg/myso-groups': permissionedGroupsPackageId,
					'@local-pkg/myso-messaging-stack': messagingPackageId,
				},
			},
		},
	});

	// When a real MyDataClient/config is provided (testnet), use `{ signer }` so the SDK
	// creates a proper SessionKey with a real personal message signature.
	// For localnet (mock mydata), use the fake SessionKey.import() shortcut.
	const sessionKey = mydata
		? { signer: keypair }
		: {
				getSessionKey: () =>
					SessionKey.import(
						{
							address: keypair.getPublicKey().toMySoAddress(),
							packageId: messagingPackageId,
							creationTimeMs: Date.now(),
							ttlMin: 30,
							sessionKey: keypair.getSecretKey(),
						},
						{} as MyDataCompatibleClient,
					),
			};

	return createClient<TApproveContext>(baseClient, {
		mydata: mydata ?? createMockMyDataClient({ mysoClient: baseClient, packageId: messagingPackageId }),
		encryption: {
			sessionKey,
			mydataPolicy,
		},
		relayer: relayer ?? { transport: noopTransport },
		packageConfig: {
			messaging: {
				originalPackageId: messagingPackageId,
				latestPackageId: messagingPackageId,
				namespaceId,
				versionId,
			},
			permissionedGroups: {
				originalPackageId: permissionedGroupsPackageId,
				latestPackageId: permissionedGroupsPackageId,
			},
		},
	});
}

/** Convenience type for the return value of `createMySoMessagingStackClient` with default (void) approve context. */
export type MySoMessagingStackTestClient = ReturnType<typeof createMySoMessagingStackClient<void>>;
