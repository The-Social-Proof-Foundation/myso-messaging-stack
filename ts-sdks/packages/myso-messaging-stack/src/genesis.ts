// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MySoGroupsPackageConfig } from '@socialproof/myso-groups';
import type { ClientWithCoreApi } from '@socialproof/myso/client';

import type { MySoMessagingStackPackageConfig } from './types.js';
import { MySoMessagingStackClientError } from './error.js';

/** Genesis system package IDs (protocol v112). */
export const GENESIS_PACKAGE_IDS = {
	framework: '0x0000000000000000000000000000000000000000000000000000000000000002',
	messaging: '0x000000000000000000000000000000000000000000000000000000000000e110',
	social: '0x00000000000000000000000000000000000000000000000000000000000050c1',
} as const;

export const GENESIS_MYSO_GROUPS_PACKAGE_CONFIG = {
	originalPackageId: GENESIS_PACKAGE_IDS.framework,
	latestPackageId: GENESIS_PACKAGE_IDS.framework,
} satisfies MySoGroupsPackageConfig;

export const GENESIS_MYSO_MESSAGING_STACK_PACKAGE_CONFIG = {
	originalPackageId: GENESIS_PACKAGE_IDS.messaging,
	latestPackageId: GENESIS_PACKAGE_IDS.messaging,
	namespaceId: '',
	versionId: '',
	blockListRegistryId: '',
	socialGraphId: '',
	memoryRegistryId: '',
	ecosystemTreasuryId: '',
} satisfies MySoMessagingStackPackageConfig;

export interface ResolvedGenesisMessagingConfig {
	messaging: MySoMessagingStackPackageConfig;
	permissionedGroups: MySoGroupsPackageConfig;
}

export interface ResolveGenesisMessagingConfigOptions {
	/** GraphQL URL for shared-object discovery. Defaults from network when omitted. */
	graphqlUrl?: string;
	/** JSON-RPC URL for publish-tx fallback when GraphQL misses a singleton. */
	rpcUrl?: string;
	signal?: AbortSignal;
}

/** Default GraphQL endpoint for local MySo nodes (`myso start --with-graphql` exposes port 9125). */
const LOCALNET_GRAPHQL_URL = 'http://localhost:9125/graphql';

const FIND_SHARED_OBJECT_QUERY = `
query findSharedObject($filter: ObjectFilter!) {
  objects(first: 2, filter: $filter) {
    nodes {
      address
    }
  }
}
`;

function defaultGraphqlUrl(network: string): string {
	switch (network) {
		case 'mainnet':
			return 'https://graphql.mainnet.mysocial.network/graphql';
		case 'testnet':
			return 'https://graphql.testnet.mysocial.network/graphql';
		case 'localnet':
		case 'devnet':
		default:
			return LOCALNET_GRAPHQL_URL;
	}
}

const genesisConfigCache = new Map<string, ResolvedGenesisMessagingConfig>();

function messagingStructType(module: string, struct: string): string {
	return `${GENESIS_PACKAGE_IDS.messaging}::${module}::${struct}`;
}

function socialStructType(module: string, struct: string): string {
	return `${GENESIS_PACKAGE_IDS.social}::${module}::${struct}`;
}

function defaultRpcUrl(network: string): string {
	switch (network) {
		case 'mainnet':
			return 'https://fullnode.mainnet.mysocial.network:443';
		case 'testnet':
			return 'https://fullnode.testnet.mysocial.network:9000';
		case 'localnet':
		case 'devnet':
		default:
			return 'http://127.0.0.1:9000';
	}
}

function isSharedOwner(owner: unknown): boolean {
	return typeof owner === 'object' && owner !== null && 'Shared' in owner;
}

interface RawTransactionEffectsCreated {
	owner: unknown;
	reference: { objectId: string };
}

async function fetchTransactionEffectsCreated(
	rpcUrl: string,
	digest: string,
	signal?: AbortSignal,
): Promise<RawTransactionEffectsCreated[]> {
	const response = await fetch(rpcUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'myso_getTransactionBlock',
			params: [digest, { showEffects: true }],
		}),
		signal,
	});

	if (!response.ok) {
		throw new MySoMessagingStackClientError(
			`RPC request failed while reading transaction effects: ${response.status} ${response.statusText}`,
		);
	}

	const payload = (await response.json()) as {
		result?: { effects?: { created?: RawTransactionEffectsCreated[] } };
		error?: { message: string };
	};

	if (payload.error) {
		throw new MySoMessagingStackClientError(
			`RPC error while reading transaction effects: ${payload.error.message}`,
		);
	}

	return payload.result?.effects?.created ?? [];
}

async function findSharedObjectIdsByTypeInPublishTx(
	client: ClientWithCoreApi,
	rpcUrl: string,
	packageId: string,
	moveType: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const { object } = await client.core.getObject({
		objectId: packageId,
		include: { previousTransaction: true },
	});

	const digest = object.previousTransaction;
	if (!digest) {
		return [];
	}

	const sharedObjectIds = (await fetchTransactionEffectsCreated(rpcUrl, digest, signal))
		.filter((created) => isSharedOwner(created.owner))
		.map((created) => created.reference.objectId);

	const matches: string[] = [];
	for (const objectId of sharedObjectIds) {
		const { object: candidate } = await client.core.getObject({ objectId });
		if (candidate.type === moveType) {
			matches.push(objectId);
		}
	}

	return matches;
}

/**
 * Resolves a genesis singleton from the package publish transaction when GraphQL
 * indexing misses it (e.g. Version not indexed as SHARED).
 */
async function findSharedObjectByTypeFromPackagePublishTx(
	client: ClientWithCoreApi,
	rpcUrl: string,
	packageId: string,
	moveType: string,
	signal?: AbortSignal,
): Promise<string | null> {
	try {
		const { object } = await client.core.getObject({
			objectId: packageId,
			include: { previousTransaction: true },
		});

		const digest = object.previousTransaction;
		if (digest) {
			const { Transaction, FailedTransaction } = await client.core.getTransaction({
				digest,
				include: { effects: true, objectTypes: true },
			});

			const txResult = Transaction ?? FailedTransaction;
			if (txResult?.effects) {
				const objectTypes = txResult.objectTypes ?? {};
				const matches = txResult.effects.changedObjects
					.filter((obj) => {
						if (obj.idOperation !== 'Created') return false;
						return objectTypes[obj.objectId] === moveType;
					})
					.map((obj) => obj.objectId);

				if (matches.length === 1) {
					return matches[0] ?? null;
				}
			}
		}
	} catch {
		// Fall through to raw RPC effects scan (genesis txs may fail SDK BCS parsing).
	}

	const rawMatches = await findSharedObjectIdsByTypeInPublishTx(
		client,
		rpcUrl,
		packageId,
		moveType,
		signal,
	);

	if (rawMatches.length === 1) {
		return rawMatches[0] ?? null;
	}

	return null;
}

async function findSharedObjectByType(
	client: ClientWithCoreApi,
	graphqlUrl: string,
	rpcUrl: string,
	packageId: string,
	moveType: string,
	label: string,
	signal?: AbortSignal,
): Promise<string> {
	const response = await fetch(graphqlUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			query: FIND_SHARED_OBJECT_QUERY,
			variables: {
				filter: {
					ownerKind: 'SHARED',
					type: moveType,
				},
			},
		}),
		signal,
	});

	if (!response.ok) {
		throw new MySoMessagingStackClientError(
			`GraphQL request failed while resolving ${label}: ${response.status} ${response.statusText}`,
		);
	}

	const payload = (await response.json()) as {
		data?: { objects?: { nodes?: { address?: string }[] } };
		errors?: { message: string }[];
	};

	if (payload.errors?.length) {
		throw new MySoMessagingStackClientError(
			`GraphQL error while resolving ${label}: ${payload.errors.map((e) => e.message).join('; ')}`,
		);
	}

	const nodes = payload.data?.objects?.nodes ?? [];
	if (nodes.length === 1 && nodes[0]?.address) {
		return nodes[0].address;
	}

	if (nodes.length > 1) {
		throw new MySoMessagingStackClientError(
			`Expected exactly one shared ${label} (${moveType}); GraphQL found ${nodes.length}.`,
		);
	}

	const rpcMatch = await findSharedObjectByTypeFromPackagePublishTx(
		client,
		rpcUrl,
		packageId,
		moveType,
		signal,
	);
	if (rpcMatch) {
		console.warn(
			`[myso-messaging-stack] GraphQL missed shared ${label} (${moveType}); ` +
				`resolved via RPC publish-tx lookup: ${rpcMatch}`,
		);
		return rpcMatch;
	}

	throw new MySoMessagingStackClientError(
		`Expected exactly one shared ${label} (${moveType}); GraphQL found 0 and RPC publish-tx lookup found 0. ` +
			'Check VITE_MYSO_RPC_URL points at the network where genesis packages 0xe110/0x50c1 were published.',
	);
}

/**
 * Resolves genesis messaging + groups package config by querying shared singleton objects once.
 * Results are cached per GraphQL URL.
 */
export async function resolveGenesisMessagingConfig(
	client: ClientWithCoreApi,
	options: ResolveGenesisMessagingConfigOptions = {},
): Promise<ResolvedGenesisMessagingConfig> {
	const graphqlUrl =
		options.graphqlUrl ??
		(client.network === 'localnet' || client.network === 'devnet'
			? LOCALNET_GRAPHQL_URL
			: defaultGraphqlUrl(client.network));
	const rpcUrl = options.rpcUrl ?? defaultRpcUrl(client.network);

	const cached = genesisConfigCache.get(graphqlUrl);
	if (cached) {
		return cached;
	}

	const [namespaceId, versionId, blockListRegistryId, socialGraphId, memoryRegistryId, ecosystemTreasuryId] =
		await Promise.all([
			findSharedObjectByType(
				client,
				graphqlUrl,
				rpcUrl,
				GENESIS_PACKAGE_IDS.messaging,
				messagingStructType('messaging', 'MessagingNamespace'),
				'MessagingNamespace',
				options.signal,
			),
			findSharedObjectByType(
				client,
				graphqlUrl,
				rpcUrl,
				GENESIS_PACKAGE_IDS.messaging,
				messagingStructType('version', 'Version'),
				'Version',
				options.signal,
			),
			findSharedObjectByType(
				client,
				graphqlUrl,
				rpcUrl,
				GENESIS_PACKAGE_IDS.social,
				socialStructType('block_list', 'BlockListRegistry'),
				'BlockListRegistry',
				options.signal,
			),
			findSharedObjectByType(
				client,
				graphqlUrl,
				rpcUrl,
				GENESIS_PACKAGE_IDS.social,
				socialStructType('social_graph', 'SocialGraph'),
				'SocialGraph',
				options.signal,
			),
			findSharedObjectByType(
				client,
				graphqlUrl,
				rpcUrl,
				GENESIS_PACKAGE_IDS.social,
				socialStructType('memory', 'MemoryRegistry'),
				'MemoryRegistry',
				options.signal,
			),
			findSharedObjectByType(
				client,
				graphqlUrl,
				rpcUrl,
				GENESIS_PACKAGE_IDS.social,
				socialStructType('profile', 'EcosystemTreasury'),
				'EcosystemTreasury',
				options.signal,
			),
		]);

	const resolved: ResolvedGenesisMessagingConfig = {
		messaging: {
			originalPackageId: GENESIS_PACKAGE_IDS.messaging,
			latestPackageId: GENESIS_PACKAGE_IDS.messaging,
			namespaceId,
			versionId,
			blockListRegistryId,
			socialGraphId,
			memoryRegistryId,
			ecosystemTreasuryId,
		},
		permissionedGroups: GENESIS_MYSO_GROUPS_PACKAGE_CONFIG,
	};

	genesisConfigCache.set(graphqlUrl, resolved);
	return resolved;
}

/** Clears the in-memory genesis config cache (for tests). */
export function clearGenesisMessagingConfigCache(): void {
	genesisConfigCache.clear();
}

/** Witness type for genesis messaging groups. */
export const GENESIS_MESSAGING_WITNESS_TYPE = `${GENESIS_PACKAGE_IDS.messaging}::messaging::Messaging`;
