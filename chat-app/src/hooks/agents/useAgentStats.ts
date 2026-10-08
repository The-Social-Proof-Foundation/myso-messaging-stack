import {useMemo} from 'react';
import {useQueries, useQuery} from '@tanstack/react-query';

import {useMessagingClient} from '../../contexts/MessagingClientContext';
import {fetchOrganizationAgentStats, mistBigint} from '../../lib/agents/profile-graphql';

const MYSO_COIN_TYPE = '0x2::myso::MYSO';
const REFRESH_MS = 30_000;

export interface AgentStats {
  /** MySo the agent's own address holds on chain. */
  balanceMist: bigint | null;
  /** AI credits the agent has spent. */
  spentMist: bigint | null;
  calls: number | null;
  budgetMist: bigint | null;
  budgetEnabled: boolean;
  memoryEntries: number | null;
}

const sameId = (a: string, b: string) =>
  a.replace(/^0x/i, '').toLowerCase() === b.replace(/^0x/i, '').toLowerCase();

/**
 * Live stats for agents in one organization: spend, calls and budget from the public indexer
 * (readable by the owner with no dashboard grant), and each agent's held MySo straight from the chain.
 * Queries are shared by key, so the chart cards and the details drawer cost one fetch.
 */
export function useAgentStats(
  organizationId: string | null,
  agents: ReadonlyArray<{id: string; fullAddress: string}>,
): ReadonlyMap<string, AgentStats> {
  const client = useMessagingClient();

  const indexed = useQuery({
    queryKey: ['agents', 'org-agent-stats', organizationId],
    enabled: Boolean(organizationId) && agents.length > 0,
    refetchInterval: REFRESH_MS,
    queryFn: ({signal}) => fetchOrganizationAgentStats(organizationId!, signal),
  });

  const balances = useQueries({
    queries: agents.map((agent) => ({
      queryKey: ['agents', 'agent-balance', agent.fullAddress.toLowerCase()],
      enabled: Boolean(client),
      refetchInterval: REFRESH_MS,
      staleTime: 10_000,
      queryFn: async () => {
        const {balance} = await client!.core.getBalance({
          owner: agent.fullAddress,
          coinType: MYSO_COIN_TYPE,
        });
        return mistBigint(balance.balance ?? balance.addressBalance);
      },
    })),
  });

  const rows = indexed.data;
  return useMemo(() => {
    const out = new Map<string, AgentStats>();
    agents.forEach((agent, index) => {
      const row = rows?.find((item) => sameId(item.agentObjectId, agent.id));
      out.set(agent.id, {
        balanceMist: balances[index]?.data ?? null,
        spentMist: row ? mistBigint(row.spentMist) : null,
        calls: row ? Number(row.usageEvents ?? 0) : null,
        budgetMist: row?.budgetEnabled && row.budgetMist != null ? mistBigint(row.budgetMist) : null,
        budgetEnabled: Boolean(row?.budgetEnabled),
        memoryEntries: row ? Number(row.memoryEntries ?? 0) : null,
      });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, rows, balances.map((query) => String(query.data ?? '')).join('|')]);
}
