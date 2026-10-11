import {useCallback, useMemo} from 'react';
import {useQuery} from '@tanstack/react-query';

import {fetchApprovedPlatforms} from '../../lib/agents/platforms';
import {
  fetchAgentReceipts,
  fetchAgentReputation,
  fetchPrincipalReputation,
  fetchTask,
  fetchTaskConfig,
  fetchTasks,
  type AgentTaskInfo,
  type TaskReceiptInfo,
} from '../../lib/agents/social-api';
import type {TaskViewer} from '../../lib/agents/tasks';
import type {PageFetcher} from '../../lib/pagination';
import {useAuthenticatedAddress} from '../../contexts/MySocialAuthContext';
import {usePaginatedList} from '../usePaginatedList';
import {agentKeys} from './query-keys';
import {useSubAgents} from './useSubAgents';

/** The signed-in principal and its agents, for recognising which side of a task they are on. */
export function useTaskViewer(): TaskViewer | null {
  const principal = useAuthenticatedAddress();
  const agents = useSubAgents(false);
  const agentIds = useMemo(() => agents.agents.map((a) => a.agent_object_id), [agents.agents]);
  return useMemo(() => (principal ? {principal, agentIds} : null), [principal, agentIds]);
}

/** One side of "my tasks": scoped by principal, so a principal's agents' tasks are included. */
function useTaskSide(which: 'buyer' | 'seller', limit?: number) {
  const principal = useAuthenticatedAddress();
  const fetchPage = useCallback<PageFetcher<AgentTaskInfo>>(
    (request, signal) =>
      principal
        ? fetchTasks(which === 'buyer' ? {buyerPrincipal: principal} : {sellerPrincipal: principal}, {
            limit: request.limit,
            offset: request.offset,
            signal,
          })
        : Promise.resolve({items: [], totalCount: null}),
    [principal, which],
  );
  return usePaginatedList<AgentTaskInfo>({
    queryKey: agentKeys.myTasks(principal ?? '', which),
    fetchPage,
    keyOf: (row) => row.taskId,
    enabled: Boolean(principal),
    limit,
  });
}

/**
 * Every task the signed-in principal is party to, as buyer or seller. The contract records the
 * principal on both sides, so tasks made or accepted by the principal's agents are included.
 */
export function useMyTasks(options: {limit?: number} = {}) {
  const asBuyer = useTaskSide('buyer', options.limit);
  const asSeller = useTaskSide('seller', options.limit);

  const tasks = useMemo(() => {
    const byId = new Map<string, AgentTaskInfo>();
    for (const row of [...asBuyer.items, ...asSeller.items]) byId.set(row.taskId, row);
    return [...byId.values()].sort(
      (a, b) => b.createdAtMs - a.createdAtMs || a.taskId.localeCompare(b.taskId),
    );
  }, [asBuyer.items, asSeller.items]);

  return {
    tasks,
    isInitialLoading: asBuyer.isInitialLoading || asSeller.isInitialLoading,
    isError: asBuyer.isError || asSeller.isError,
    error: asBuyer.error ?? asSeller.error,
    hasNextPage: asBuyer.hasNextPage || asSeller.hasNextPage,
    isFetchingNextPage: asBuyer.isFetchingNextPage || asSeller.isFetchingNextPage,
    fetchNextPage: () => {
      if (asBuyer.hasNextPage) asBuyer.fetchNextPage();
      if (asSeller.hasNextPage) asSeller.fetchNextPage();
    },
    refetch: () => {
      asBuyer.refetch();
      asSeller.refetch();
    },
  };
}

export function useTask(taskId: string | null) {
  return useQuery({
    queryKey: agentKeys.task(taskId ?? ''),
    queryFn: () => fetchTask(taskId!),
    enabled: Boolean(taskId),
    // A task changes with every party action, so keep it fresh while its pane is open.
    refetchInterval: 15_000,
  });
}

export function useTaskConfig() {
  return useQuery({
    queryKey: agentKeys.taskConfig(),
    queryFn: fetchTaskConfig,
    staleTime: 60_000,
  });
}

export function useAgentReceipts(agentObjectId: string | null) {
  const fetchPage = useCallback<PageFetcher<TaskReceiptInfo>>(
    (request, signal) =>
      agentObjectId
        ? fetchAgentReceipts(agentObjectId, {limit: request.limit, offset: request.offset, signal})
        : Promise.resolve({items: [], totalCount: null}),
    [agentObjectId],
  );
  return usePaginatedList<TaskReceiptInfo>({
    queryKey: agentKeys.agentReceipts(agentObjectId ?? ''),
    fetchPage,
    keyOf: (row) => row.taskId,
    enabled: Boolean(agentObjectId),
  });
}

/** An agent's own seller and buyer scores. A new agent resolves to the prior, not to null. */
export function useAgentReputation(agentObjectId: string | null | undefined) {
  return useQuery({
    queryKey: agentKeys.agentReputation(agentObjectId ?? ''),
    queryFn: () => fetchAgentReputation(agentObjectId!),
    // Callers pass half-typed ids from inputs; only a well-formed object id is worth a request.
    enabled: Boolean(agentObjectId && /^0x[0-9a-fA-F]{1,64}$/.test(agentObjectId)),
    staleTime: 30_000,
  });
}

export function usePrincipalReputation(address: string | null | undefined) {
  return useQuery({
    queryKey: agentKeys.principalReputation(address ?? ''),
    queryFn: () => fetchPrincipalReputation(address!),
    enabled: Boolean(address),
    staleTime: 30_000,
  });
}

/**
 * Any approved platform object. `settle_task` and `release_task` take a `Platform`; it is only
 * funded when the offer was bound to one, and the contract ignores it otherwise.
 */
export function useAnyPlatformId() {
  return useQuery({
    queryKey: agentKeys.anyPlatform(),
    queryFn: async () => {
      const page = await fetchApprovedPlatforms({limit: 1, offset: 0});
      return page.items[0]?.platformId ?? null;
    },
    staleTime: 5 * 60_000,
  });
}
