import {useCallback, useMemo} from 'react';
import {useQuery} from '@tanstack/react-query';

import {agentNamesByDerivedAddress} from '../../lib/agents/agent-display-name';
import {buildAgentTree} from '../../lib/agents/agent-tree';
import {
  fetchSubAgentByObjectId,
  fetchSubAgents,
  type SubAgentRow,
} from '../../lib/agents/social-api';
import {collectAllPages, type PageFetcher} from '../../lib/pagination';
import {useAuthenticatedAddress} from '../../contexts/MySocialAuthContext';
import {usePaginatedList} from '../usePaginatedList';
import type {ListOptions} from './useOrganizations';
import {agentKeys} from './query-keys';

/**
 * Paged sub-agents registered by the signed-in wallet.
 *
 * `totalCount` is the endpoint's `total_count` for **all** matching rows, not just the
 * loaded ones, which is what key derivation depends on: the next free derivation index is
 * the owner's total registered agent count. Encrypted key recovery uses object IDs.
 * Always take the bound from the all-rows list (`activeOnly = false`).
 */
export function useSubAgents(activeOnly = false, options: ListOptions = {}) {
  const address = useAuthenticatedAddress();
  const enabled = Boolean(address) && (options.enabled ?? true);

  const fetchPage = useCallback<PageFetcher<SubAgentRow>>(
    (request, signal) =>
      address
        ? fetchSubAgents(address, {
            activeOnly,
            limit: request.limit,
            offset: request.offset,
            signal,
          })
        : Promise.resolve({items: [], totalCount: null}),
    [address, activeOnly],
  );

  const list = usePaginatedList<SubAgentRow>({
    queryKey: agentKeys.subAgents(address ?? '', activeOnly),
    fetchPage,
    keyOf: (row) => row.agent_object_id,
    enabled,
    limit: options.limit,
  });

  const tree = useMemo(() => buildAgentTree(list.items), [list.items]);

  return {...list, agents: list.items, tree};
}

/**
 * Resolves one agent by object id without depending on which pages are loaded.
 *
 * Deep links (`/agents` → "Chat" → home) and reloads must be able to open an agent the
 * paged list has not reached yet.
 */
export function useSubAgentByObjectId(agentObjectId: string | null) {
  return useQuery({
    queryKey: ['agents', 'sub-agent-by-object', agentObjectId ?? ''],
    queryFn: () => fetchSubAgentByObjectId(agentObjectId!),
    enabled: Boolean(agentObjectId),
    staleTime: 60_000,
  });
}

/**
 * The complete sub-agent set for the signed-in wallet, walked page-by-page up front.
 *
 * Organization-scoped views need every agent to filter by `organization_id`, and the
 * endpoint has no organization filter, so a progressive list would silently hide agents on
 * unloaded pages. `complete` reports whether the walk actually reached the end.
 */
export function useAllSubAgents(options: {enabled?: boolean} = {}) {
  const address = useAuthenticatedAddress();
  const enabled = Boolean(address) && (options.enabled ?? true);

  const query = useQuery({
    queryKey: [...agentKeys.subAgents(address ?? '', false), 'all'] as const,
    enabled,
    staleTime: 30_000,
    queryFn: (context) =>
      collectAllPages<SubAgentRow>(
        (request) =>
          fetchSubAgents(address!, {
            activeOnly: false,
            limit: request.limit,
            offset: request.offset,
            signal: context.signal,
          }),
        {keyOf: (row) => row.agent_object_id, signal: context.signal},
      ),
  });

  return {
    items: query.data?.items ?? [],
    complete: query.data?.complete ?? false,
    reason: query.data?.reason ?? null,
    partialError: query.data?.partialError ?? null,
    totalCount: query.data?.totalCount ?? null,
    isLoading: query.isPending && enabled,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

/** Agent display names keyed by derived address, for chat titles. */
export function useAgentNamesByAddress(): Map<string, string> {
  const agents = useAllSubAgents();
  return useMemo(() => agentNamesByDerivedAddress(agents.items), [agents.items]);
}
