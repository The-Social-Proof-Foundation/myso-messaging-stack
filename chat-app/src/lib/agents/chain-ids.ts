import {
  GENESIS_PACKAGE_IDS,
  resolveGenesisMessagingConfig,
} from '@socialproof/myso-messaging-stack';

import {
  createBaseMySoRpcClient,
  getGenesisGraphqlUrl,
  getMessagingRpcUrl,
} from '../messaging-client-factory';

/** Shared objects the agents workspace passes into `memory::*` and `ai_credit::*` calls. */
export interface AgentChainIds {
  socialPackageId: string;
  memoryConfigId: string;
  aiCreditConfigId: string;
  /** Shared `platform::PlatformRegistry` — needed to join a platform before agent messaging. */
  platformRegistryId: string;
  /** Shared `block_list::BlockListRegistry` — required by `platform::join_platform`. */
  blockListRegistryId: string;
}

const GRAPHQL_URL = import.meta.env.VITE_MYSO_GRAPHQL_URL || '/api/graphql';

const FIND_SHARED_OBJECT_QUERY = `
query findSharedObject($filter: ObjectFilter!) {
  objects(first: 2, filter: $filter) {
    nodes {
      address
    }
  }
}
`;

async function findSharedObjectId(moveType: string, label: string): Promise<string> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: FIND_SHARED_OBJECT_QUERY,
      variables: { filter: { ownerKind: 'SHARED', type: moveType } },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `GraphQL request failed while resolving ${label}: ${response.status} ${response.statusText}`,
    );
  }
  const payload = (await response.json()) as {
    data?: { objects?: { nodes?: { address?: string }[] } };
    errors?: { message: string }[];
  };
  if (payload.errors?.length) {
    throw new Error(
      `GraphQL error while resolving ${label}: ${payload.errors.map((e) => e.message).join('; ')}`,
    );
  }
  const nodes = payload.data?.objects?.nodes ?? [];
  if (nodes.length !== 1 || !nodes[0]?.address) {
    throw new Error(
      `Expected exactly one shared ${label} (${moveType}); GraphQL found ${nodes.length}.`,
    );
  }
  return nodes[0].address;
}

let cached: Promise<AgentChainIds> | null = null;

/** Resolves (once per page load) the genesis shared objects used by agent transactions. */
export function resolveAgentChainIds(): Promise<AgentChainIds> {
  if (!cached) {
    cached = (async () => {
      const [genesis, aiCreditConfigId, platformRegistryId, blockListRegistryId] =
        await Promise.all([
          resolveGenesisMessagingConfig(createBaseMySoRpcClient(), {
            graphqlUrl: getGenesisGraphqlUrl(),
            rpcUrl: getMessagingRpcUrl(),
          }),
          findSharedObjectId(
            `${GENESIS_PACKAGE_IDS.social}::ai_credit::AiCreditConfig`,
            'AiCreditConfig',
          ),
          findSharedObjectId(
            `${GENESIS_PACKAGE_IDS.social}::platform::PlatformRegistry`,
            'PlatformRegistry',
          ),
          findSharedObjectId(
            `${GENESIS_PACKAGE_IDS.social}::block_list::BlockListRegistry`,
            'BlockListRegistry',
          ),
        ]);
      return {
        socialPackageId: GENESIS_PACKAGE_IDS.social,
        memoryConfigId: genesis.messaging.memoryConfigId,
        aiCreditConfigId,
        platformRegistryId,
        blockListRegistryId,
      };
    })().catch((error: unknown) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}
