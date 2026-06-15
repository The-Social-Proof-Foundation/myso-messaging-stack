// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { SessionKey } from '@socialproof/mydata';
import { SessionKey as SessionKeyClass } from '@socialproof/mydata';
import type { MyDataCompatibleClient } from '@socialproof/mydata';
import { mysoGroups } from '@socialproof/myso-groups';
import { MySoJsonRpcClient } from '@socialproof/myso/jsonRpc';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { describe, expect, it } from 'vitest';

import { MySoMessagingStackClient, mysoMessagingStack } from '../../src/client.js';
import { MySoMessagingStackClientError } from '../../src/error.js';
import type { MySoMessagingStackEncryptionOptions } from '../../src/types.js';
import { createMockMyDataClient } from './helpers/mock-mydata-client.js';

const MOCK_PACKAGE_ID = '0x' + 'ab'.repeat(32);
const MOCK_NAMESPACE_ID = '0x' + '99'.repeat(32);
const MOCK_VERSION_ID = '0x' + '11'.repeat(32);
const MOCK_BLOCK_LIST_ID = '0x' + '22'.repeat(32);
const MOCK_SOCIAL_GRAPH_ID = '0x' + '33'.repeat(32);
const MOCK_PACKAGE_CONFIG = {
	originalPackageId: MOCK_PACKAGE_ID,
	latestPackageId: MOCK_PACKAGE_ID,
	namespaceId: MOCK_NAMESPACE_ID,
	versionId: MOCK_VERSION_ID,
	blockListRegistryId: MOCK_BLOCK_LIST_ID,
	socialGraphId: MOCK_SOCIAL_GRAPH_ID,
};
const MOCK_PERMISSIONED_GROUPS_PACKAGE_ID = '0x' + 'ff'.repeat(32);
const MOCK_WITNESS_TYPE = `${MOCK_PERMISSIONED_GROUPS_PACKAGE_ID}::messaging::Messaging`;
const MOCK_RELAYER_CONFIG = {
	relayerUrl: 'http://localhost:3000',
};

const mockMyDataMySoClient = {} as MyDataCompatibleClient;

function createMockSessionKey(): SessionKey {
	const keypair = Ed25519Keypair.generate();
	return SessionKeyClass.import(
		{
			address: keypair.getPublicKey().toMySoAddress(),
			packageId: '0x' + '00'.repeat(32),
			creationTimeMs: Date.now(),
			ttlMin: 30,
			sessionKey: keypair.getSecretKey(),
		},
		mockMyDataMySoClient,
	);
}

function createMockEncryptionOptions(): MySoMessagingStackEncryptionOptions {
	const sessionKey = createMockSessionKey();
	return {
		sessionKey: { getSessionKey: () => sessionKey },
	};
}

function createMyDataExtension() {
	return {
		name: 'mydata' as const,
		register: () => createMockMyDataClient(),
	};
}

function createExtendedClient(network: string = 'localnet') {
	const mysoClient = new MySoJsonRpcClient({ url: 'http://127.0.0.1:9000', network });
	return mysoClient.$extend(
		mysoGroups({
			witnessType: MOCK_WITNESS_TYPE,
			packageConfig: {
				originalPackageId: MOCK_PERMISSIONED_GROUPS_PACKAGE_ID,
				latestPackageId: MOCK_PERMISSIONED_GROUPS_PACKAGE_ID,
			},
		}),
		createMyDataExtension(),
	);
}

describe('MySoMessagingStackClient', () => {
	describe('constructor validation', () => {
		it('should throw if client is not provided', () => {
			expect(
				() =>
					new MySoMessagingStackClient({
						client: undefined as any,
						groupsName: 'groups',
						mydataName: 'mydata',
						packageConfig: MOCK_PACKAGE_CONFIG,
						encryption: createMockEncryptionOptions(),
						relayer: MOCK_RELAYER_CONFIG,
					}),
			).toThrow(MySoMessagingStackClientError);
			expect(
				() =>
					new MySoMessagingStackClient({
						client: undefined as any,
						groupsName: 'groups',
						mydataName: 'mydata',
						packageConfig: MOCK_PACKAGE_CONFIG,
						encryption: createMockEncryptionOptions(),
						relayer: MOCK_RELAYER_CONFIG,
					}),
			).toThrow('client must be provided');
		});

		it('should throw for unsupported network without packageConfig', () => {
			expect(
				() =>
					new MySoMessagingStackClient({
						client: createExtendedClient('localnet') as any,
						groupsName: 'groups',
						mydataName: 'mydata',
						encryption: createMockEncryptionOptions(),
						relayer: MOCK_RELAYER_CONFIG,
					}),
			).toThrow(MySoMessagingStackClientError);
			expect(
				() =>
					new MySoMessagingStackClient({
						client: createExtendedClient('localnet') as any,
						groupsName: 'groups',
						mydataName: 'mydata',
						encryption: createMockEncryptionOptions(),
						relayer: MOCK_RELAYER_CONFIG,
					}),
			).toThrow('packageConfig is required');
		});

		it('should accept custom packageConfig for localnet', () => {
			const client = new MySoMessagingStackClient({
				client: createExtendedClient() as any,
				groupsName: 'groups',
				mydataName: 'mydata',
				packageConfig: MOCK_PACKAGE_CONFIG,
				encryption: createMockEncryptionOptions(),
				relayer: MOCK_RELAYER_CONFIG,
			});
			expect(client).toBeInstanceOf(MySoMessagingStackClient);
		});

		it('should expose call, tx, view, bcs, derive, encryption, transport', () => {
			const client = new MySoMessagingStackClient({
				client: createExtendedClient() as any,
				groupsName: 'groups',
				mydataName: 'mydata',
				packageConfig: MOCK_PACKAGE_CONFIG,
				encryption: createMockEncryptionOptions(),
				relayer: MOCK_RELAYER_CONFIG,
			});

			expect(client.call).toBeDefined();
			expect(client.tx).toBeDefined();
			expect(client.view).toBeDefined();
			expect(client.bcs).toBeDefined();
			expect(client.derive).toBeDefined();
			expect(client.encryption).toBeDefined();
			expect(client.transport).toBeDefined();
		});
	});
});

describe('mysoMessagingStack factory + $extend', () => {
	it('should extend MySoClient and expose sub-modules via client.messaging', () => {
		const client = createExtendedClient().$extend(
			mysoMessagingStack({
				packageConfig: MOCK_PACKAGE_CONFIG,
				encryption: createMockEncryptionOptions(),
				relayer: MOCK_RELAYER_CONFIG,
			}),
		);

		expect(client.messaging).toBeDefined();
		expect(client.messaging).toBeInstanceOf(MySoMessagingStackClient);
		expect(client.messaging.call).toBeDefined();
		expect(client.messaging.tx).toBeDefined();
		expect(client.messaging.view).toBeDefined();
		expect(client.messaging.bcs).toBeDefined();
		expect(client.messaging.derive).toBeDefined();
		expect(client.messaging.encryption).toBeDefined();
	});

	it('should use custom name when provided', () => {
		const client = createExtendedClient().$extend(
			mysoMessagingStack({
				name: 'chat',
				packageConfig: MOCK_PACKAGE_CONFIG,
				encryption: createMockEncryptionOptions(),
				relayer: MOCK_RELAYER_CONFIG,
			}),
		);

		expect(client.chat).toBeDefined();
		expect(client.chat).toBeInstanceOf(MySoMessagingStackClient);
	});

	it('should compose with mysoGroups and mydata extensions', () => {
		const client = createExtendedClient().$extend(
			mysoMessagingStack({
				packageConfig: MOCK_PACKAGE_CONFIG,
				encryption: createMockEncryptionOptions(),
				relayer: MOCK_RELAYER_CONFIG,
			}),
		);

		// All three extensions should coexist
		expect(client.groups).toBeDefined();
		expect(client.mydata).toBeDefined();
		expect(client.messaging).toBeDefined();
	});

	it('should support custom groupsName and mydataName', () => {
		const mysoClient = new MySoJsonRpcClient({ url: 'http://127.0.0.1:9000', network: 'localnet' });
		const client = mysoClient
			.$extend(
				mysoGroups({
					name: 'permissions',
					witnessType: MOCK_WITNESS_TYPE,
					packageConfig: {
						originalPackageId: MOCK_PERMISSIONED_GROUPS_PACKAGE_ID,
						latestPackageId: MOCK_PERMISSIONED_GROUPS_PACKAGE_ID,
					},
				}),
				{ name: 'myMyData' as const, register: () => createMockMyDataClient() },
			)
			.$extend(
				mysoMessagingStack({
					groupsName: 'permissions',
					mydataName: 'myMyData',
					packageConfig: MOCK_PACKAGE_CONFIG,
					encryption: createMockEncryptionOptions(),
					relayer: MOCK_RELAYER_CONFIG,
				}),
			);

		expect(client.permissions).toBeDefined();
		expect(client.myMyData).toBeDefined();
		expect(client.messaging).toBeDefined();
		expect(client.messaging).toBeInstanceOf(MySoMessagingStackClient);
	});
});
