// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { ClientWithCoreApi } from '@socialproof/myso/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	clearGenesisMessagingConfigCache,
	GENESIS_PACKAGE_IDS,
	resolveGenesisMessagingConfig,
} from '../../src/genesis.js';
import { MySoMessagingStackClientError } from '../../src/error.js';

const GRAPHQL_URL = 'http://localhost:9999/graphql';
const RPC_URL = 'http://localhost:9998/rpc';
const PUBLISH_DIGEST = 'PublishDigest123';

const VERSION_TYPE = `${GENESIS_PACKAGE_IDS.messaging}::version::Version`;
const NAMESPACE_TYPE = `${GENESIS_PACKAGE_IDS.messaging}::messaging::MessagingNamespace`;
const BLOCK_LIST_TYPE = `${GENESIS_PACKAGE_IDS.social}::block_list::BlockListRegistry`;
const SOCIAL_GRAPH_TYPE = `${GENESIS_PACKAGE_IDS.social}::social_graph::SocialGraph`;
const MEMORY_REGISTRY_TYPE = `${GENESIS_PACKAGE_IDS.social}::memory::MemoryRegistry`;

const MOCK_NAMESPACE_ID = '0x' + 'aa'.repeat(32);
const MOCK_VERSION_ID = '0x' + 'bb'.repeat(32);
const MOCK_BLOCK_LIST_ID = '0x' + 'cc'.repeat(32);
const MOCK_SOCIAL_GRAPH_ID = '0x' + 'dd'.repeat(32);
const MOCK_MEMORY_REGISTRY_ID = '0x' + 'ee'.repeat(32);

const OBJECT_TYPES: Record<string, string> = {
	[MOCK_NAMESPACE_ID]: NAMESPACE_TYPE,
	[MOCK_VERSION_ID]: VERSION_TYPE,
	[MOCK_BLOCK_LIST_ID]: BLOCK_LIST_TYPE,
	[MOCK_SOCIAL_GRAPH_ID]: SOCIAL_GRAPH_TYPE,
	[MOCK_MEMORY_REGISTRY_ID]: MEMORY_REGISTRY_TYPE,
};

function graphqlResponse(nodes: { address: string }[]) {
	return {
		ok: true,
		json: async () => ({
			data: { objects: { nodes } },
		}),
	};
}

function rpcEffectsResponse(sharedObjectIds: string[]) {
	return {
		ok: true,
		json: async () => ({
			result: {
				effects: {
					created: sharedObjectIds.map((objectId) => ({
						owner: { Shared: { initial_shared_version: 1 } },
						reference: { objectId },
					})),
				},
			},
		}),
	};
}

function createMockClient(options?: {
	versionInPublishTx?: boolean;
	getTransactionThrows?: boolean;
}): ClientWithCoreApi {
	const versionInPublishTx = options?.versionInPublishTx ?? true;
	const getTransactionThrows = options?.getTransactionThrows ?? false;

	return {
		network: 'localnet',
		core: {
			getObject: vi.fn(async ({ objectId }: { objectId: string }) => {
				if (objectId === GENESIS_PACKAGE_IDS.messaging || objectId === GENESIS_PACKAGE_IDS.social) {
					return {
						object: { previousTransaction: PUBLISH_DIGEST },
					};
				}

				const type = OBJECT_TYPES[objectId];
				if (type) {
					return { object: { type } };
				}

				throw new Error(`unexpected getObject: ${objectId}`);
			}),
			getTransaction: vi.fn(async () => {
				if (getTransactionThrows) {
					throw new Error('BCS parse failure');
				}

				const messagingCreated = [
					{
						objectId: MOCK_NAMESPACE_ID,
						idOperation: 'Created' as const,
					},
					...(versionInPublishTx
						? [{ objectId: MOCK_VERSION_ID, idOperation: 'Created' as const }]
						: []),
				];

				const socialCreated = [
					{ objectId: MOCK_BLOCK_LIST_ID, idOperation: 'Created' as const },
					{ objectId: MOCK_SOCIAL_GRAPH_ID, idOperation: 'Created' as const },
					{ objectId: MOCK_MEMORY_REGISTRY_ID, idOperation: 'Created' as const },
				];

				const objectTypes: Record<string, string> = { ...OBJECT_TYPES };
				if (!versionInPublishTx) {
					delete objectTypes[MOCK_VERSION_ID];
				}

				return {
					Transaction: {
						effects: {
							changedObjects: [...messagingCreated, ...socialCreated],
						},
						objectTypes,
					},
				};
			}),
		},
	} as unknown as ClientWithCoreApi;
}

function mockGraphqlFetch(fetchMock: ReturnType<typeof vi.fn>) {
	fetchMock.mockImplementation(async (input, init) => {
		const url = String(input);
		if (url === RPC_URL) {
			return rpcEffectsResponse([
				MOCK_NAMESPACE_ID,
				MOCK_VERSION_ID,
				MOCK_BLOCK_LIST_ID,
				MOCK_SOCIAL_GRAPH_ID,
				MOCK_MEMORY_REGISTRY_ID,
			]) as Response;
		}

		const body = JSON.parse((init as RequestInit).body as string) as {
			variables: { filter: { type: string } };
		};
		const moveType = body.variables.filter.type;

		if (moveType === VERSION_TYPE) {
			return graphqlResponse([]) as Response;
		}
		if (moveType === NAMESPACE_TYPE) {
			return graphqlResponse([{ address: MOCK_NAMESPACE_ID }]) as Response;
		}
		if (moveType === BLOCK_LIST_TYPE) {
			return graphqlResponse([{ address: MOCK_BLOCK_LIST_ID }]) as Response;
		}
		if (moveType === SOCIAL_GRAPH_TYPE) {
			return graphqlResponse([{ address: MOCK_SOCIAL_GRAPH_ID }]) as Response;
		}
		if (moveType === MEMORY_REGISTRY_TYPE) {
			return graphqlResponse([{ address: MOCK_MEMORY_REGISTRY_ID }]) as Response;
		}
		throw new Error(`unexpected GraphQL type: ${moveType}`);
	});
}

describe('resolveGenesisMessagingConfig RPC fallback', () => {
	beforeEach(() => {
		clearGenesisMessagingConfigCache();
		vi.stubGlobal('fetch', vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		clearGenesisMessagingConfigCache();
	});

	it('resolves Version via SDK publish-tx lookup when GraphQL returns 0', async () => {
		mockGraphqlFetch(vi.mocked(fetch));

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const resolved = await resolveGenesisMessagingConfig(createMockClient(), {
			graphqlUrl: GRAPHQL_URL,
			rpcUrl: RPC_URL,
		});

		expect(resolved.messaging.versionId).toBe(MOCK_VERSION_ID);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GraphQL missed shared Version'));
	});

	it('resolves Version via raw RPC effects scan when SDK getTransaction fails', async () => {
		mockGraphqlFetch(vi.mocked(fetch));

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const resolved = await resolveGenesisMessagingConfig(
			createMockClient({ getTransactionThrows: true }),
			{
				graphqlUrl: GRAPHQL_URL,
				rpcUrl: RPC_URL,
			},
		);

		expect(resolved.messaging.versionId).toBe(MOCK_VERSION_ID);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GraphQL missed shared Version'));
	});

	it('throws when GraphQL and RPC both miss Version', async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockImplementation(async (input, init) => {
			const url = String(input);
			if (url === RPC_URL) {
				return rpcEffectsResponse([
					MOCK_NAMESPACE_ID,
					MOCK_BLOCK_LIST_ID,
					MOCK_SOCIAL_GRAPH_ID,
					MOCK_MEMORY_REGISTRY_ID,
				]) as Response;
			}

			const body = JSON.parse((init as RequestInit).body as string) as {
				variables: { filter: { type: string } };
			};
			const moveType = body.variables.filter.type;

			if (moveType === VERSION_TYPE) {
				return graphqlResponse([]) as Response;
			}
			if (moveType === NAMESPACE_TYPE) {
				return graphqlResponse([{ address: MOCK_NAMESPACE_ID }]) as Response;
			}
			if (moveType === BLOCK_LIST_TYPE) {
				return graphqlResponse([{ address: MOCK_BLOCK_LIST_ID }]) as Response;
			}
			if (moveType === SOCIAL_GRAPH_TYPE) {
				return graphqlResponse([{ address: MOCK_SOCIAL_GRAPH_ID }]) as Response;
			}
			if (moveType === MEMORY_REGISTRY_TYPE) {
				return graphqlResponse([{ address: MOCK_MEMORY_REGISTRY_ID }]) as Response;
			}
			throw new Error(`unexpected GraphQL type: ${moveType}`);
		});

		await expect(
			resolveGenesisMessagingConfig(
				createMockClient({ versionInPublishTx: false, getTransactionThrows: true }),
				{ graphqlUrl: GRAPHQL_URL, rpcUrl: RPC_URL },
			),
		).rejects.toThrow(MySoMessagingStackClientError);

		await expect(
			resolveGenesisMessagingConfig(
				createMockClient({ versionInPublishTx: false, getTransactionThrows: true }),
				{ graphqlUrl: GRAPHQL_URL, rpcUrl: RPC_URL },
			),
		).rejects.toThrow(/GraphQL found 0 and RPC publish-tx lookup found 0/);
	});
});
