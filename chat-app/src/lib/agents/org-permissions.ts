/**
 * `social_contracts::memory` organization permission bits (`ORG_PERM_*`).
 *
 * These are granted on the organization's memory-share group. The social server's
 * `/organizations/:id/*` dashboard routes require `DashboardViewer`, and `/audit-logs`
 * requires `Auditor`; nothing grants them implicitly — not even to the organization owner —
 * so the app must grant them explicitly.
 */
export const ORG_PERM = {
  MEMORY_READ: 1,
  MEMORY_WRITE: 2,
  AGENT_MANAGER: 4,
  BUDGET_MANAGER: 8,
  SPEND_APPROVER: 16,
  DASHBOARD_VIEWER: 32,
  AUDITOR: 64,
} as const;

export type OrgPermissionName = keyof typeof ORG_PERM;

export const ORG_PERMISSION_LABELS: Record<OrgPermissionName, string> = {
  MEMORY_READ: 'Read shared memory',
  MEMORY_WRITE: 'Write shared memory',
  AGENT_MANAGER: 'Manage agents',
  BUDGET_MANAGER: 'Manage budgets',
  SPEND_APPROVER: 'Approve spend',
  DASHBOARD_VIEWER: 'View dashboard',
  AUDITOR: 'View audit log',
};

/** What the owner needs to use every organization-management screen. */
export const ORG_OWNER_MASK =
  ORG_PERM.MEMORY_READ |
  ORG_PERM.MEMORY_WRITE |
  ORG_PERM.AGENT_MANAGER |
  ORG_PERM.BUDGET_MANAGER |
  ORG_PERM.SPEND_APPROVER |
  ORG_PERM.DASHBOARD_VIEWER |
  ORG_PERM.AUDITOR;

/** The subset the dashboard and audit screens need, for a targeted repair. */
export const ORG_DASHBOARD_MASK = ORG_PERM.DASHBOARD_VIEWER | ORG_PERM.AUDITOR;

export function orgPermissionNames(mask: number): OrgPermissionName[] {
  return (Object.keys(ORG_PERM) as OrgPermissionName[]).filter(
    (name) => (mask & ORG_PERM[name]) === ORG_PERM[name],
  );
}

export function orgPermissionSummary(mask: number): string {
  return orgPermissionNames(mask)
    .map((name) => ORG_PERMISSION_LABELS[name])
    .join(', ');
}
