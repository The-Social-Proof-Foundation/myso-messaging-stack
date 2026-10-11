import {useCallback} from 'react';

import {
  fetchAgentRooms,
  fetchGroupDigests,
  type AgentRoomInfo,
  type GroupDigestInfo,
} from '../../lib/agents/social-api';
import type {PageFetcher} from '../../lib/pagination';
import {useAuthenticatedAddress} from '../../contexts/MySocialAuthContext';
import {usePaginatedList} from '../usePaginatedList';
import {agentKeys} from './query-keys';

/** Paged agent rooms created by the signed-in principal's agents. */
export function useAgentRooms(options: {enabled?: boolean; limit?: number} = {}) {
  const principal = useAuthenticatedAddress();
  const enabled = Boolean(principal) && (options.enabled ?? true);

  const fetchPage = useCallback<PageFetcher<AgentRoomInfo>>(
    (request, signal) =>
      principal
        ? fetchAgentRooms(principal, {limit: request.limit, offset: request.offset, signal})
        : Promise.resolve({items: [], totalCount: null}),
    [principal],
  );

  const list = usePaginatedList<AgentRoomInfo>({
    queryKey: agentKeys.agentRooms(principal ?? ''),
    fetchPage,
    keyOf: (row) => row.groupId,
    enabled,
    limit: options.limit,
  });

  return {...list, rooms: list.items};
}

/** Paged on-chain message digests for one group, in sequence order. */
export function useGroupDigests(groupId: string | null, options: {limit?: number} = {}) {
  const fetchPage = useCallback<PageFetcher<GroupDigestInfo>>(
    (request, signal) =>
      groupId
        ? fetchGroupDigests(groupId, {limit: request.limit, offset: request.offset, signal})
        : Promise.resolve({items: [], totalCount: null}),
    [groupId],
  );

  const list = usePaginatedList<GroupDigestInfo>({
    queryKey: agentKeys.groupDigests(groupId ?? ''),
    fetchPage,
    keyOf: (row) => `${row.groupId}:${row.seq}`,
    enabled: Boolean(groupId),
    limit: options.limit,
  });

  return {...list, digests: list.items};
}
