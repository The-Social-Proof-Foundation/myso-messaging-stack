/**
 * React Query keys for the agents workspace.
 *
 * Every key is prefixed with `agents` so `useInvalidateAgents` can invalidate the whole
 * workspace (including every page of every paged list) with one prefix match.
 */
export type ListFilters = Record<string, string | number | boolean | null | undefined>;

export const agentKeys = {
  all: ['agents'] as const,
  memoryAccount: (address: string) => ['agents', 'memory-account', address] as const,
  aiCredit: (address: string) => ['agents', 'ai-credit', address] as const,
  aiCreditConfig: () => ['agents', 'ai-credit-config'] as const,
  aiCreditUsage: (balanceId: string, filters?: ListFilters) =>
    ['agents', 'ai-credit-usage', balanceId, filters ?? null] as const,
  aiCreditReservations: (balanceId: string, filters?: ListFilters) =>
    ['agents', 'ai-credit-reservations', balanceId, filters ?? null] as const,
  profileApprovals: (address: string, filters?: ListFilters) =>
    ['agents', 'profile-approvals', address, filters ?? null] as const,
  profileAuditLogs: (address: string, filters?: ListFilters) =>
    ['agents', 'profile-audit-logs', address, filters ?? null] as const,

  subAgents: (address: string, activeOnly: boolean) =>
    ['agents', 'sub-agents', address, activeOnly] as const,
  organizations: (address: string, activeOnly: boolean) =>
    ['agents', 'organizations', address, activeOnly] as const,
  organization: (id: string) => ['agents', 'organization', id] as const,
  organizationMessagingGroups: (id: string, filters?: ListFilters) =>
    ['agents', 'organization-messaging-groups', id, filters ?? null] as const,

  agentRooms: (principal: string) => ['agents', 'rooms', principal] as const,
  organizationRooms: (id: string) => ['agents', 'organization-rooms', id] as const,
  groupDigests: (groupId: string) => ['agents', 'group-digests', groupId] as const,

  myTasks: (address: string, side: 'buyer' | 'seller') => ['agents', 'tasks', address, side] as const,
  task: (taskId: string) => ['agents', 'task', taskId] as const,
  taskDispute: (taskId: string) => ['agents', 'task-dispute', taskId] as const,
  juryRationales: (caseId: string) => ['agents', 'jury-rationales', caseId] as const,
  ownerJurors: (principal: string) => ['agents', 'jury-roster', principal] as const,
  jurorDuties: (agentId: string) => ['agents', 'juror-duties', agentId] as const,
  agentReceipts: (agentObjectId: string) => ['agents', 'receipts', agentObjectId] as const,
  taskConfig: () => ['agents', 'task-config'] as const,
  agentReputation: (agentObjectId: string) => ['agents', 'reputation', agentObjectId] as const,
  principalReputation: (address: string) => ['agents', 'principal-reputation', address] as const,
  anyPlatform: () => ['agents', 'any-platform'] as const,

  organizationDashboard: (id: string) => ['agents', 'organization-dashboard', id] as const,
  organizationMemoryPermissions: (id: string, filters?: ListFilters) =>
    ['agents', 'organization-dashboard', id, 'memory-permissions', filters ?? null] as const,
  organizationRoles: (id: string, filters?: ListFilters) =>
    ['agents', 'organization-dashboard', id, 'roles', filters ?? null] as const,
  organizationRoleAssignments: (id: string, filters?: ListFilters) =>
    ['agents', 'organization-dashboard', id, 'role-assignments', filters ?? null] as const,
  organizationInvitations: (id: string, filters?: ListFilters) =>
    ['agents', 'organization-dashboard', id, 'invitations', filters ?? null] as const,
  organizationApprovals: (id: string, filters?: ListFilters) =>
    ['agents', 'organization-dashboard', id, 'approvals', filters ?? null] as const,
  organizationSpendBreakdown: (id: string, filters?: ListFilters) =>
    ['agents', 'organization-dashboard', id, 'spend-breakdown', filters ?? null] as const,
  organizationAuditLogs: (id: string, filters?: ListFilters) =>
    ['agents', 'organization-dashboard', id, 'audit-logs', filters ?? null] as const,

  organizationCategories: () => ['agents', 'organization-categories'] as const,
  profileOverview: (address: string) => ['agents', 'profile-overview', address] as const,

  /**
   * Automation is keyed by account: the relayer derives the account from the
   * request signature, so two agents under one address can see different jobs
   * and must not share a cache entry.
   */
  automationJobs: (accountId: string) => ['agents', 'automation-jobs', accountId] as const,
  automationRuns: (accountId: string, jobId: string) =>
    ['agents', 'automation-runs', accountId, jobId] as const,
  automationHealth: (accountId: string) =>
    ['agents', 'automation-health', accountId] as const,
  automationDelegates: (accountId: string) =>
    ['agents', 'automation-delegates', accountId] as const,
};
