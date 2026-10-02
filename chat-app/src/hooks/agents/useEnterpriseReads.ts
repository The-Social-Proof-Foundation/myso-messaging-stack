import {useCallback} from 'react';

import {
  fetchOrganizationMessagingGroups,
  fetchProfileAuditLogs,
  fetchProfileSpendApprovals,
  type AiCreditSpendApprovalRow,
  type MessagingAgentGroupInfo,
  type OrgAuditLogRow,
} from '../../lib/agents/social-api';
import type {PageFetcher} from '../../lib/pagination';
import {usePaginatedList} from '../usePaginatedList';
import {agentKeys} from './query-keys';

/**
 * Paged agent messaging groups recorded for an organization.
 *
 * This is the social indexer's `messaging_agent_groups` view: it survives relayer gaps
 * (the relayer's own table is insert-only with no backfill) and carries
 * `creatorSubAgentId`, which is what ties a group to an agent.
 */
export function useOrganizationMessagingGroups(
  organizationId: string | null | undefined,
  options: {limit?: number; enabled?: boolean; keyOf?: (row: MessagingAgentGroupInfo) => string} = {},
) {
  const {limit, keyOf} = options;
  const fetchPage = useCallback<PageFetcher<MessagingAgentGroupInfo>>(
    (request, signal) =>
      organizationId
        ? fetchOrganizationMessagingGroups(organizationId, {
            limit: request.limit,
            offset: request.offset,
            signal,
          })
        : Promise.resolve({items: [], totalCount: null}),
    [organizationId],
  );

  return usePaginatedList<MessagingAgentGroupInfo>({
    queryKey: agentKeys.organizationMessagingGroups(organizationId ?? ''),
    fetchPage,
    keyOf: keyOf ?? ((row) => row.groupId),
    enabled: Boolean(organizationId) && (options.enabled ?? true),
    limit,
  });
}

export function useProfileSpendApprovals(
  address: string | null | undefined,
  options: {status?: string; agent?: string; limit?: number; enabled?: boolean} = {},
) {
  const {status, agent, limit} = options;
  const fetchPage = useCallback<PageFetcher<AiCreditSpendApprovalRow>>(
    (request, signal) =>
      address
        ? fetchProfileSpendApprovals(address, {
            limit: request.limit,
            offset: request.offset,
            status,
            agent,
            signal,
          })
        : Promise.resolve({items: [], totalCount: null}),
    [address, status, agent],
  );

  return usePaginatedList<AiCreditSpendApprovalRow>({
    queryKey: agentKeys.profileApprovals(address ?? '', {status, agent}),
    fetchPage,
    keyOf: (row) => `${row.balance_id}:${row.agent_object_id}:${row.requested_at}`,
    enabled: Boolean(address) && (options.enabled ?? true),
    limit,
  });
}

export function useProfileAuditLogs(
  address: string | null | undefined,
  filters: {
    action?: string;
    actor?: string;
    targetType?: string;
    source?: string;
    limit?: number;
    enabled?: boolean;
  } = {},
) {
  const {action, actor, targetType, source, limit} = filters;
  const fetchPage = useCallback<PageFetcher<OrgAuditLogRow>>(
    (request, signal) =>
      address
        ? fetchProfileAuditLogs(address, {
            limit: request.limit,
            offset: request.offset,
            action,
            actor,
            targetType,
            source,
            signal,
          })
        : Promise.resolve({items: [], totalCount: null}),
    [address, action, actor, targetType, source],
  );

  return usePaginatedList<OrgAuditLogRow>({
    queryKey: agentKeys.profileAuditLogs(address ?? '', {
      action,
      actor,
      targetType,
      source,
    }),
    fetchPage,
    keyOf: (row) => String(row.id),
    enabled: Boolean(address) && (filters.enabled ?? true),
    limit,
  });
}
