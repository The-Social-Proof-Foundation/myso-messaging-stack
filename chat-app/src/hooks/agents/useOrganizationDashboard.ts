import {useCallback} from 'react';

import {
  fetchOrganizationAuditLogs,
  fetchOrganizationInvitations,
  fetchOrganizationMemoryPermissions,
  fetchOrganizationRoleAssignments,
  fetchOrganizationRoles,
  fetchOrganizationSpendApprovals,
  fetchOrganizationSpendBreakdown,
  type AgentSpendBreakdownEntry,
  type AiCreditSpendApprovalRow,
  type OrgAuditLogRow,
  type OrgInvitationRow,
  type OrgMemoryPermissionRow,
  type OrgRoleAssignmentRow,
  type OrgRoleRow,
  type OrgStatsWindow,
} from '../../lib/agents/social-api';
import type {PageFetcher, PageResult} from '../../lib/pagination';
import {useMySocialAuth} from '../../contexts/MySocialAuthContext';
import {usePaginatedList, type PaginatedListResult} from '../usePaginatedList';
import {agentKeys} from './query-keys';

/** Disabled-query placeholder: a page with nothing in it and no reported total. */
function emptyPage<T>(): PageResult<T> {
  return {items: [], totalCount: null};
}

export interface OrgDashboardFilters {
  /** Restrict member-keyed lists to one address. */
  member?: string;
  activeOnly?: boolean;
  invitationStatus?: string;
  approvalStatus?: string;
  approvalAgent?: string;
  spendWindow?: OrgStatsWindow;
  audit?: {
    action?: string;
    actor?: string;
    targetType?: string;
    source?: string;
  };
  limit?: number;
}

export function useOrgMemoryPermissions(
  id: string | null,
  filters: OrgDashboardFilters = {},
) {
  const {keypair} = useMySocialAuth();
  const {member, activeOnly, limit} = filters;
  const enabled = Boolean(id && keypair);

  const fetchPage = useCallback<PageFetcher<OrgMemoryPermissionRow>>(
    (request, signal) =>
      id && keypair
        ? fetchOrganizationMemoryPermissions(id, keypair, {
            limit: request.limit,
            offset: request.offset,
            member,
            activeOnly,
            signal,
          })
        : Promise.resolve(emptyPage()),
    [id, keypair, member, activeOnly],
  );

  return usePaginatedList<OrgMemoryPermissionRow>({
    queryKey: agentKeys.organizationMemoryPermissions(id ?? '', {member, activeOnly}),
    fetchPage,
    keyOf: (row) => `${row.member_address}:${row.permission_kind}`,
    enabled,
    limit,
  });
}

export function useOrgRoles(id: string | null, filters: OrgDashboardFilters = {}) {
  const {keypair} = useMySocialAuth();
  const {limit} = filters;

  const fetchPage = useCallback<PageFetcher<OrgRoleRow>>(
    (request, signal) =>
      id && keypair
        ? fetchOrganizationRoles(id, keypair, {
            limit: request.limit,
            offset: request.offset,
            signal,
          })
        : Promise.resolve(emptyPage()),
    [id, keypair],
  );

  return usePaginatedList<OrgRoleRow>({
    queryKey: agentKeys.organizationRoles(id ?? ''),
    fetchPage,
    keyOf: (row) => row.role_name,
    enabled: Boolean(id && keypair),
    limit,
  });
}

export function useOrgRoleAssignments(id: string | null, filters: OrgDashboardFilters = {}) {
  const {keypair} = useMySocialAuth();
  const {member, activeOnly, limit} = filters;

  const fetchPage = useCallback<PageFetcher<OrgRoleAssignmentRow>>(
    (request, signal) =>
      id && keypair
        ? fetchOrganizationRoleAssignments(id, keypair, {
            limit: request.limit,
            offset: request.offset,
            member,
            activeOnly,
            signal,
          })
        : Promise.resolve(emptyPage()),
    [id, keypair, member, activeOnly],
  );

  return usePaginatedList<OrgRoleAssignmentRow>({
    queryKey: agentKeys.organizationRoleAssignments(id ?? '', {member, activeOnly}),
    fetchPage,
    keyOf: (row) => `${row.member_address}:${row.role_name}`,
    enabled: Boolean(id && keypair),
    limit,
  });
}

export function useOrgInvitations(id: string | null, filters: OrgDashboardFilters = {}) {
  const {keypair} = useMySocialAuth();
  const {invitationStatus, member, limit} = filters;

  const fetchPage = useCallback<PageFetcher<OrgInvitationRow>>(
    (request, signal) =>
      id && keypair
        ? fetchOrganizationInvitations(id, keypair, {
            limit: request.limit,
            offset: request.offset,
            invitee: member,
            status: invitationStatus,
            signal,
          })
        : Promise.resolve(emptyPage()),
    [id, keypair, member, invitationStatus],
  );

  return usePaginatedList<OrgInvitationRow>({
    queryKey: agentKeys.organizationInvitations(id ?? '', {
      invitee: member,
      status: invitationStatus,
    }),
    fetchPage,
    keyOf: (row) => `${row.invitee_address}:${row.created_at_ms}`,
    enabled: Boolean(id && keypair),
    limit,
  });
}

export function useOrgSpendApprovals(id: string | null, filters: OrgDashboardFilters = {}) {
  const {keypair} = useMySocialAuth();
  const {approvalStatus, approvalAgent, limit} = filters;

  const fetchPage = useCallback<PageFetcher<AiCreditSpendApprovalRow>>(
    (request, signal) =>
      id && keypair
        ? fetchOrganizationSpendApprovals(id, keypair, {
            limit: request.limit,
            offset: request.offset,
            status: approvalStatus,
            agent: approvalAgent,
            signal,
          })
        : Promise.resolve(emptyPage()),
    [id, keypair, approvalStatus, approvalAgent],
  );

  return usePaginatedList<AiCreditSpendApprovalRow>({
    queryKey: agentKeys.organizationApprovals(id ?? '', {
      status: approvalStatus,
      agent: approvalAgent,
    }),
    fetchPage,
    keyOf: (row) => `${row.balance_id}:${row.agent_object_id}:${row.requested_at}`,
    enabled: Boolean(id && keypair),
    limit,
  });
}

export function useOrgSpendBreakdown(id: string | null, filters: OrgDashboardFilters = {}) {
  const {keypair} = useMySocialAuth();
  const {spendWindow, limit} = filters;

  const fetchPage = useCallback<PageFetcher<AgentSpendBreakdownEntry>>(
    (request, signal) =>
      id && keypair
        ? fetchOrganizationSpendBreakdown(id, keypair, {
            limit: request.limit,
            offset: request.offset,
            window: spendWindow,
            signal,
          })
        : Promise.resolve(emptyPage()),
    [id, keypair, spendWindow],
  );

  return usePaginatedList<AgentSpendBreakdownEntry>({
    queryKey: agentKeys.organizationSpendBreakdown(id ?? '', {window: spendWindow}),
    fetchPage,
    keyOf: (row) => row.agent_object_id,
    enabled: Boolean(id && keypair),
    limit,
  });
}

/**
 * Auditor-gated read: a 403 means the wallet is not an auditor for this organization, which
 * the UI must present differently from a generic failure.
 */
export function useOrgAuditLogs(id: string | null, filters: OrgDashboardFilters = {}) {
  const {keypair} = useMySocialAuth();
  const {audit, limit} = filters;
  const action = audit?.action;
  const actor = audit?.actor;
  const targetType = audit?.targetType;
  const source = audit?.source;

  const fetchPage = useCallback<PageFetcher<OrgAuditLogRow>>(
    (request, signal) =>
      id && keypair
        ? fetchOrganizationAuditLogs(id, keypair, {
            limit: request.limit,
            offset: request.offset,
            action,
            actor,
            targetType,
            source,
            signal,
          })
        : Promise.resolve(emptyPage()),
    [id, keypair, action, actor, targetType, source],
  );

  return usePaginatedList<OrgAuditLogRow>({
    queryKey: agentKeys.organizationAuditLogs(id ?? '', {
      action,
      actor,
      targetType,
      source,
    }),
    fetchPage,
    keyOf: (row) => String(row.id),
    enabled: Boolean(id && keypair),
    limit,
  });
}

export interface OrganizationDashboardLists {
  memoryPermissions: PaginatedListResult<OrgMemoryPermissionRow>;
  roles: PaginatedListResult<OrgRoleRow>;
  roleAssignments: PaginatedListResult<OrgRoleAssignmentRow>;
  invitations: PaginatedListResult<OrgInvitationRow>;
  approvals: PaginatedListResult<AiCreditSpendApprovalRow>;
  spendBreakdown: PaginatedListResult<AgentSpendBreakdownEntry>;
  auditLogs: PaginatedListResult<OrgAuditLogRow>;
}

/**
 * Every organization-management list as an independent paged query, so each section can
 * load, filter, page, and retry on its own instead of one failure blanking the dashboard.
 */
export function useOrganizationDashboard(
  id: string | null,
  filters: OrgDashboardFilters = {},
): OrganizationDashboardLists {
  const memoryPermissions = useOrgMemoryPermissions(id, filters);
  const roles = useOrgRoles(id, filters);
  const roleAssignments = useOrgRoleAssignments(id, filters);
  const invitations = useOrgInvitations(id, filters);
  const approvals = useOrgSpendApprovals(id, filters);
  const spendBreakdown = useOrgSpendBreakdown(id, filters);
  const auditLogs = useOrgAuditLogs(id, filters);

  return {
    memoryPermissions,
    roles,
    roleAssignments,
    invitations,
    approvals,
    spendBreakdown,
    auditLogs,
  };
}
