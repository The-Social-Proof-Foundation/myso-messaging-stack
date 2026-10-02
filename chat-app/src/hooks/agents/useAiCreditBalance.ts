import {useCallback} from 'react';
import {useQuery} from '@tanstack/react-query';

import {
  fetchAiCreditBalance,
  fetchAiCreditConfig,
  fetchAiCreditReservations,
  fetchAiCreditUsage,
  type AiCreditUsageLineRow,
  type AiSpendReservationRow,
} from '../../lib/agents/social-api';
import type {PageFetcher} from '../../lib/pagination';
import {useAuthenticatedAddress} from '../../contexts/MySocialAuthContext';
import {usePaginatedList} from '../usePaginatedList';
import {agentKeys} from './query-keys';

export function useAiCreditBalance() {
  const address = useAuthenticatedAddress();
  return useQuery({
    queryKey: agentKeys.aiCredit(address ?? ''),
    queryFn: () => fetchAiCreditBalance(address!),
    enabled: Boolean(address),
  });
}

export function useAiCreditConfig() {
  return useQuery({
    queryKey: agentKeys.aiCreditConfig(),
    queryFn: fetchAiCreditConfig,
  });
}

/**
 * Paged AI-credit usage history. The endpoint returns a bare array (no `total_count`), so
 * the pager stops on a short or empty page; `truncated` surfaces a partial list honestly.
 */
export function useAiCreditUsage(balanceId: string | undefined, limit?: number) {
  const fetchPage = useCallback<PageFetcher<AiCreditUsageLineRow>>(
    (request, signal) =>
      balanceId
        ? fetchAiCreditUsage(balanceId, {
            limit: request.limit,
            offset: request.offset,
            signal,
          })
        : Promise.resolve({items: [], totalCount: null}),
    [balanceId],
  );

  return usePaginatedList<AiCreditUsageLineRow>({
    queryKey: agentKeys.aiCreditUsage(balanceId ?? ''),
    fetchPage,
    keyOf: (row) => String(row.id),
    enabled: Boolean(balanceId),
    limit,
  });
}

export function useAiCreditReservations(
  balanceId: string | undefined,
  options: {status?: string; limit?: number; enabled?: boolean} = {},
) {
  const {status, limit} = options;
  const fetchPage = useCallback<PageFetcher<AiSpendReservationRow>>(
    (request, signal) =>
      balanceId
        ? fetchAiCreditReservations(balanceId, {
            limit: request.limit,
            offset: request.offset,
            status,
            signal,
          })
        : Promise.resolve({items: [], totalCount: null}),
    [balanceId, status],
  );

  return usePaginatedList<AiSpendReservationRow>({
    queryKey: agentKeys.aiCreditReservations(balanceId ?? '', {status}),
    fetchPage,
    keyOf: (row) => `${row.balance_id}:${row.reservation_nonce}`,
    enabled: Boolean(balanceId) && (options.enabled ?? true),
    limit,
  });
}
