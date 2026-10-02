import {useCallback} from 'react';
import {useQuery} from '@tanstack/react-query';

import {
  fetchOrganization,
  fetchOrganizations,
  type AgenticOrganizationRow,
} from '../../lib/agents/social-api';
import type {PageFetcher} from '../../lib/pagination';
import {useAuthenticatedAddress} from '../../contexts/MySocialAuthContext';
import {usePaginatedList} from '../usePaginatedList';
import {agentKeys} from './query-keys';

export interface ListOptions {
  limit?: number;
  enabled?: boolean;
}

/**
 * Paged organizations owned by the signed-in wallet.
 *
 * A wallet can own more than the server's 100-row clamp, so callers use
 * `fetchNextPage`; `totalCount` is the endpoint's authoritative `total_count`.
 */
export function useOrganizations(activeOnly = false, options: ListOptions = {}) {
  const address = useAuthenticatedAddress();
  const enabled = Boolean(address) && (options.enabled ?? true);

  const fetchPage = useCallback<PageFetcher<AgenticOrganizationRow>>(
    (request, signal) =>
      address
        ? fetchOrganizations(address, {
            activeOnly,
            limit: request.limit,
            offset: request.offset,
            signal,
          })
        : Promise.resolve({items: [], totalCount: null}),
    [address, activeOnly],
  );

  const list = usePaginatedList<AgenticOrganizationRow>({
    queryKey: agentKeys.organizations(address ?? '', activeOnly),
    fetchPage,
    keyOf: (row) => row.organization_id,
    enabled,
    limit: options.limit,
  });

  return {...list, organizations: list.items};
}

export function useOrganization(id: string | null) {
  return useQuery({
    queryKey: agentKeys.organization(id ?? ''),
    queryFn: () => fetchOrganization(id!),
    enabled: Boolean(id),
  });
}
