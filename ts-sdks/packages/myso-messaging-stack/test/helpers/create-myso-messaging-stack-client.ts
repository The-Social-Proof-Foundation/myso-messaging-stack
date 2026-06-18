// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type {
	MyDataClient,
	MyDataClientOptions,
	MyDataCompatibleClient,
} from '@socialproof/mydata';
import { SessionKey } from '@socialproof/mydata';
import {
	createMySoMessagingStackClient as createClient,
	type RelayerConfig,
	type RelayerTransport,
	type MyDataPolicy,
	type ResolvedGenesisMessagingConfig,
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
	getUserReadState: () => {
		throw new Error('noopTransport: getUserReadState not implemented');
	},
	putUserReadState: () => {
		throw new Error('noopTransport: putUserReadState not implemented');
	},
	postPushToken: () => {
		throw new Error('noopTransport: postPushToken not implemented');
	},
	deletePushToken: () => {
		throw new Error('noopTransport: deletePushToken not implemented');
	},
	postPresence: () => {
		throw new Error('noopTransport: postPresence not implemented');
	},
	disconnect: () => {},
};

export interface CreateMySoMessagingStackClientOptions<TApproveContext = void> {
	url: string;
	network: MySoClientTypes.Network;
	transport?: MySoTransport;
	/** Resolved genesis config from bootstrapLocalnet or testnet discovery. */
	packageConfig: ResolvedGenesisMessagingConfig;
	keypair: Ed25519Keypair;
	mydataPolicy?: MyDataPolicy<TApproveContext>;
	relayer?: RelayerConfig;
	mydata?: MyDataClient | Omit<MyDataClientOptions, 'mysoClient'>;
}

/**
 * Creates a fully extended MySo client with `mysoGroups`, `mydata`,
 * and `mysoMessagingStack` extensions.
 */
export function createMySoMessagingStackClient<TApproveContext = void>(
	options: CreateMySoMessagingStackClientOptions<TApproveContext>,
) {
	const { url, network, transport, packageConfig, keypair, mydataPolicy, relayer, mydata } =
		options;

	const messagingPackageId = packageConfig.messaging.originalPackageId;

	const baseClient = createMySoClient({
		url,
		network,
		transport,
		mvr: {
			overrides: {
				packages: {
					'@local-pkg/myso-groups': packageConfig.permissionedGroups.originalPackageId,
					'@local-pkg/messaging': messagingPackageId,
				},
			},
		},
	});

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
		mydata:
			mydata ?? createMockMyDataClient({ mysoClient: baseClient, packageId: messagingPackageId }),
		encryption: {
			sessionKey,
			mydataPolicy,
		},
		relayer: relayer ?? { transport: noopTransport },
		packageConfig,
	});
}

/** Convenience type for the return value of `createMySoMessagingStackClient` with default (void) approve context. */
export type MySoMessagingStackTestClient = ReturnType<typeof createMySoMessagingStackClient<void>>;
