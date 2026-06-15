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
} satisfies MySoMessagingStackPackageConfig;

export interface ResolvedGenesisMessagingConfig {
	messaging: MySoMessagingStackPackageConfig;
	permissionedGroups: MySoGroupsPackageConfig;
}

export interface ResolveGenesisMessagingConfigOptions {
	/** GraphQL URL for shared-object discovery. Defaults from network when omitted. */
	graphqlUrl?: string;
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

async function findSharedObjectByType(
	graphqlUrl: string,
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
	if (nodes.length !== 1 || !nodes[0]?.address) {
		throw new MySoMessagingStackClientError(
			`Expected exactly one shared ${label} (${moveType}); found ${nodes.length}. ` +
				'Ensure genesis messaging/social bootstrap ran on this network.',
		);
	}

	return nodes[0].address;
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

	const cached = genesisConfigCache.get(graphqlUrl);
	if (cached) {
		return cached;
	}

	const [namespaceId, versionId, blockListRegistryId, socialGraphId] = await Promise.all([
		findSharedObjectByType(
			graphqlUrl,
			messagingStructType('messaging', 'MessagingNamespace'),
			'MessagingNamespace',
			options.signal,
		),
		findSharedObjectByType(
			graphqlUrl,
			messagingStructType('version', 'Version'),
			'Version',
			options.signal,
		),
		findSharedObjectByType(
			graphqlUrl,
			socialStructType('block_list', 'BlockListRegistry'),
			'BlockListRegistry',
			options.signal,
		),
		findSharedObjectByType(
			graphqlUrl,
			socialStructType('social_graph', 'SocialGraph'),
			'SocialGraph',
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
