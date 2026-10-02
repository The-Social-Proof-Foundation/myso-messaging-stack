import {useQueryClient} from '@tanstack/react-query';

import {upsertCollectedSubAgent} from '../../lib/agents/seed-sub-agent';
import type {SubAgentRow} from '../../lib/agents/social-api';
import type {CollectResult} from '../../lib/pagination';
import {useAuthenticatedAddress} from '../../contexts/MySocialAuthContext';
import {agentKeys} from './query-keys';

/**
 * Invalidates the whole agents workspace after any on-chain agent/organization/credit
 * write. A single `agentKeys.all` prefix covers every paged list (all loaded pages),
 * the dashboard sections, the per-organization detail reads, and the capability queries,
 * so a mutation cannot leave a stale page behind.
 */
export function useInvalidateAgents() {
  const queryClient = useQueryClient();

  return async (_organizationId?: string | null) => {
    await queryClient.invalidateQueries({queryKey: agentKeys.all});
  };
}

/** Writes a just-created agent into the full list the org chart renders. */
export function useSeedCreatedSubAgent() {
  const queryClient = useQueryClient();
  const address = useAuthenticatedAddress();

  return (row: SubAgentRow) => {
    if (!address) return;
    const key = [...agentKeys.subAgents(address, false), 'all'] as const;
    queryClient.setQueryData<CollectResult<SubAgentRow>>(key, (current) =>
      upsertCollectedSubAgent(current, row),
    );
  };
}
