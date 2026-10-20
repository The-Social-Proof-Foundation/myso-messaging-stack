import {useCallback, useMemo, useSyncExternalStore} from 'react';

import {
  fetchAgentRooms,
  fetchGroupDigests,
  fetchOrganizationRooms,
  type AgentRoomInfo,
  type GroupDigestInfo,
} from '../../lib/agents/social-api';
import type {PageFetcher} from '../../lib/pagination';
import {useAuthenticatedAddress} from '../../contexts/MySocialAuthContext';
import {
  mergePendingDigests,
  pendingDigestVersion,
  subscribePendingDigests,
} from '../../lib/agents/pending-digests';
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

/** Paged rooms recorded for one organization. */
export function useOrganizationRooms(
  organizationId: string | null | undefined,
  options: {enabled?: boolean; limit?: number} = {},
) {
  const enabled = Boolean(organizationId) && (options.enabled ?? true);

  const fetchPage = useCallback<PageFetcher<AgentRoomInfo>>(
    (request, signal) =>
      organizationId
        ? fetchOrganizationRooms(organizationId, {limit: request.limit, offset: request.offset, signal})
        : Promise.resolve({items: [], totalCount: null}),
    [organizationId],
  );

  const list = usePaginatedList<AgentRoomInfo>({
    queryKey: agentKeys.organizationRooms(organizationId ?? ''),
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

  const pendingVersion = useSyncExternalStore(subscribePendingDigests, pendingDigestVersion, () => 0);
  const digests = useMemo(
    () => (groupId ? mergePendingDigests(groupId, list.items) : list.items),
    [groupId, list.items, pendingVersion],
  );

  return {...list, digests};
}
