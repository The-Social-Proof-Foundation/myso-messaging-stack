import {Children, useEffect, useMemo, useState, type ReactNode} from 'react';
import {ORG_PERM_MEMORY_READ, ORG_PERM_MEMORY_WRITE} from '@socialproof/memory/account';

import {buttonClass, cardClass, fieldClass, sectionTitleClass} from './chrome';
import {ListError, ListSection, LoadMoreRow} from './ListStates';
import {CreateOrganizationDialog} from './CreateOrganizationDialog';
import {AgentOrgChart} from '../blocks/AgentOrgChart';
import {Button} from '../Button';
import {organizationCategoryLabel} from '../../lib/agents/org-types';
import {agentForestToChart} from '../../lib/agents/agent-chart';
import {buildAgentTree} from '../../lib/agents/agent-tree';
import {MysoAmount} from './MysoAmount';
import {formatMistAmount, parseMysoToMist, truncateAddress} from '../../lib/agents/format';
import {
  formatTimestamp,
  groupOrganizationMembers,
  humanizeKey,
  permissionSummary,
  titleizeStatus,
} from '../../lib/agents/org-display';
import {SocialServerError} from '../../lib/agents/social-api';
import {useAuthenticatedAddress} from '../../contexts/MySocialAuthContext';
import {
  useAgentActions,
  useAiCreditBalance,
  useMemoryAccount,
  useOrganization,
  useOrganizations,
  useOrgAuditLogs,
  useOrgInvitations,
  useOrgMemoryPermissions,
  useOrgRoleAssignments,
  useOrgRoles,
  useOrgSpendApprovals,
  useOrgSpendBreakdown,
  useOrganizationMessagingGroups,
} from '../../hooks/agents';
import {useAllSubAgents} from '../../hooks/agents/useSubAgents';

const DEFAULT_ORG_PERMS = ORG_PERM_MEMORY_READ | ORG_PERM_MEMORY_WRITE;

/** A 403 from the auditor-gated audit log means "not an auditor", not "broken". */
function isForbidden(error: unknown): boolean {
  return error instanceof SocialServerError && (error.status === 403 || error.status === 401);
}

export function OrganizationsPanel() {
  const orgs = useOrganizations(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewOrg, setShowNewOrg] = useState(false);

  useEffect(() => {
    if (selectedId || orgs.organizations.length === 0) return;
    setSelectedId(orgs.organizations[0].organization_id);
  }, [orgs.organizations, selectedId]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-stretch gap-2 overflow-x-auto pb-1">
          {orgs.isInitialLoading ? (
            <p className="self-center text-sm text-secondary-500">Loading organizations…</p>
          ) : orgs.isError ? (
            <ListError error={orgs.error} onRetry={orgs.refetch} className="px-0 py-1" />
          ) : orgs.organizations.length === 0 ? (
            <p className="self-center text-sm text-secondary-500">No organizations yet.</p>
          ) : (
            orgs.organizations.map((org) => {
              const selected = selectedId === org.organization_id;
              return (
                <button
                  key={org.organization_id}
                  type="button"
                  onClick={() => setSelectedId(org.organization_id)}
                  className={`shrink-0 rounded-lg border px-3 py-2 text-left ${
                    selected
                      ? 'border-secondary-300 bg-secondary-100 text-primary-900 dark:border-secondary-600 dark:bg-secondary-800 dark:text-primary-50'
                      : 'border-secondary-200 bg-white text-secondary-700 hover:bg-secondary-50 dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-200 dark:hover:bg-secondary-800/60'
                  }`}
                >
                  <span className="block max-w-48 truncate text-sm font-medium">
                    {org.name || 'Untitled'}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-secondary-500">
                    <span>{organizationCategoryLabel(org.org_type)}</span>
                    <span aria-hidden="true">·</span>
                    <span className={org.active ? '' : 'text-danger-500'}>
                      {org.active ? 'Active' : 'Inactive'}
                    </span>
                  </span>
                </button>
              );
            })
          )}
          {orgs.hasNextPage ? (
            <button
              type="button"
              onClick={orgs.fetchNextPage}
              disabled={orgs.isFetchingNextPage}
              className="shrink-0 self-center rounded-lg border border-secondary-200 px-3 py-2 text-xs text-secondary-600 hover:bg-secondary-50 disabled:opacity-50 dark:border-secondary-700 dark:text-secondary-300 dark:hover:bg-secondary-800"
            >
              {orgs.isFetchingNextPage ? 'Loading…' : 'More'}
            </button>
          ) : null}
        </div>
        <Button size="sm" className="shrink-0" onClick={() => setShowNewOrg(true)}>
          New
        </Button>
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        {selectedId ? (
          <OrganizationDetail key={selectedId} organizationId={selectedId} />
        ) : (
          <p className="text-sm text-secondary-500">Select an organization to manage it.</p>
        )}
      </div>

      <CreateOrganizationDialog
        open={showNewOrg}
        onClose={() => setShowNewOrg(false)}
        onCreated={(organizationId) => setSelectedId(organizationId)}
      />
    </div>
  );
}

function OrganizationDetail({organizationId}: Readonly<{organizationId: string}>) {
  const account = useMemoryAccount();
  const org = useOrganization(organizationId);
  const agents = useAllSubAgents();
  const credit = useAiCreditBalance();
  const actions = useAgentActions();

  const [invitee, setInvitee] = useState('');
  const [member, setMember] = useState('');
  const [roleName, setRoleName] = useState('memory_administrator');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approveMist, setApproveMist] = useState('1');
  const [invitationStatus, setInvitationStatus] = useState('');
  const [approvalStatus, setApprovalStatus] = useState('');
  const [spendWindow, setSpendWindow] = useState<'days7' | 'days30' | 'days180' | 'all'>('days30');
  const [auditAction, setAuditAction] = useState('');
  const [auditActor, setAuditActor] = useState('');

  const memberFilter = member.trim() || undefined;
  const dashFilters = useMemo(
    () => ({
      member: memberFilter,
      activeOnly: false,
      invitationStatus: invitationStatus || undefined,
      approvalStatus: approvalStatus || undefined,
      spendWindow,
      audit: {
        action: auditAction.trim() || undefined,
        actor: auditActor.trim() || undefined,
      },
    }),
    [memberFilter, invitationStatus, approvalStatus, spendWindow, auditAction, auditActor],
  );

  const memoryPermissions = useOrgMemoryPermissions(organizationId, dashFilters);
  const roles = useOrgRoles(organizationId, dashFilters);
  const roleAssignments = useOrgRoleAssignments(organizationId, dashFilters);
  const invitations = useOrgInvitations(organizationId, dashFilters);
  const approvals = useOrgSpendApprovals(organizationId, dashFilters);
  const spendBreakdown = useOrgSpendBreakdown(organizationId, dashFilters);
  const auditLogs = useOrgAuditLogs(organizationId, dashFilters);
  const messagingGroups = useOrganizationMessagingGroups(organizationId);
  const owner = useAuthenticatedAddress() ?? '';

  const needsDashboardAccess = [
    memoryPermissions,
    roles,
    roleAssignments,
    invitations,
    approvals,
    spendBreakdown,
    auditLogs,
  ].some((list) => isForbidden(list.error));

  const orgAgents = useMemo(
    () => agents.items.filter((agent) => agent.organization_id === organizationId),
    [agents.items, organizationId],
  );
  const chartRoots = useMemo(
    () => agentForestToChart(buildAgentTree(orgAgents)),
    [orgAgents],
  );
  const members = useMemo(
    () => groupOrganizationMembers(memoryPermissions.items, roleAssignments.items),
    [memoryPermissions.items, roleAssignments.items],
  );
  const row = org.data;
  const groupId = row?.org_memory_group_id;

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (org.isLoading) return <p className="text-sm text-secondary-500">Loading organization…</p>;
  if (org.isError)
    return <ListError error={org.error} onRetry={() => void org.refetch()} className="px-0" />;
  if (!row || !account.data)
    return <p className="text-sm text-secondary-500">Organization not found.</p>;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className={`${cardClass} p-4`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className={sectionTitleClass}>{row.name || 'Untitled'}</h2>
            <p className="mt-1 max-w-[65ch] text-sm text-secondary-500">
              {row.description || 'No description'}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <QuietChip>{organizationCategoryLabel(row.org_type)}</QuietChip>
              <QuietChip tone={row.active ? 'neutral' : 'danger'}>
                {row.active ? 'Active' : 'Inactive'}
              </QuietChip>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={Boolean(busy) || Boolean(groupId)}
              onClick={() =>
                void run('memory', async () => {
                  await actions.ensureOrgMemory({
                    accountId: account.data!.account_id,
                    organizationId,
                    ownerAddress: owner,
                  });
                })
              }
            >
              {groupId
                ? 'Shared memory enabled'
                : busy === 'memory'
                  ? 'Enabling…'
                  : 'Enable shared memory'}
            </Button>
            {row.active ? (
              <Button
                variant="danger"
                size="sm"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run('deact', () =>
                    actions.deactivateOrganization({
                      accountId: account.data!.account_id,
                      organizationId,
                    }),
                  )
                }
              >
                {busy === 'deact' ? 'Deactivating…' : 'Deactivate'}
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      {needsDashboardAccess ? (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/40">
          <h3 className="font-chakra text-sm font-medium tracking-wide text-amber-900 dark:text-amber-100">
            Dashboard access needed
          </h3>
          <p className="mt-1 text-xs text-amber-900 dark:text-amber-100">
            The dashboard lists read the organization&apos;s granted permissions, and this wallet
            does not hold Dashboard viewer or Auditor yet, so nothing is granted implicitly, not even to the
            owner. Granting them once fixes every section below, including each agent's audit log.
          </p>
          <Button
            size="sm"
            className="mt-2"
            disabled={Boolean(busy) || !groupId}
            onClick={() =>
              void run('dashboard', () =>
                actions.grantOwnerOrgPermissions({
                  accountId: account.data!.account_id,
                  organizationId,
                  orgMemoryGroupId: groupId!,
                  ownerAddress: owner,
                }),
              )
            }
          >
            {busy === 'dashboard' ? 'Granting…' : 'Grant dashboard access'}
          </Button>
          {!groupId ? (
            <p className="mt-1 text-xs text-amber-900 dark:text-amber-100">
              Enable shared memory first. Organization permissions are granted on that group.
            </p>
          ) : null}
        </section>
      ) : null}

      {agents.isLoading ? (
        <p className="text-sm text-secondary-500">Loading agents…</p>
      ) : agents.isError ? (
        <ListError error={agents.error} onRetry={() => void agents.refetch()} className="px-0" />
      ) : (
        <AgentOrgChart
          title={row.name || 'Untitled'}
          roots={chartRoots}
          organizationId={organizationId}
          onAgentCreated={() => void agents.refetch()}
        />
      )}
      {!agents.complete && !agents.isLoading && !agents.isError ? (
        <p className="text-xs text-secondary-400">
          Showing {agents.items.length}
          {agents.totalCount != null ? ` of ${agents.totalCount}` : ''} agents.{' '}
          <button type="button" onClick={() => void agents.refetch()} className="underline">
            Retry
          </button>
        </p>
      ) : null}

      <ListSection
        title="Agent chats"
        list={messagingGroups}
        empty="No agent chats recorded for this organization yet."
        showCompleteCount={false}
      >
        <ul className="mt-2 divide-y divide-secondary-200 dark:divide-secondary-700">
          {messagingGroups.items.map((chat) => (
            <RecordRow
              key={chat.groupId}
              title={chat.groupName}
              meta={
                chat.creatorSubAgentId
                  ? `Created by ${truncateAddress(chat.creatorSubAgentId)} · ${truncateAddress(chat.creatorPrincipal)}`
                  : `Created by an unattributed agent · ${truncateAddress(chat.creatorPrincipal)}`
              }
            />
          ))}
        </ul>
      </ListSection>

      <section className={`${cardClass} p-4`}>
        <h3 className={sectionTitleClass}>People</h3>
        <div className="mt-3 max-w-sm">
          <Field
            label="Filter by member"
            hint="Grant, revoke, and role actions use this address."
          >
            <input
              value={member}
              onChange={(event) => setMember(event.target.value)}
              placeholder="0x…"
              className={`${fieldClass} w-full text-xs`}
            />
          </Field>
        </div>

        <div className="mt-4 border-t border-secondary-200 pt-3 dark:border-secondary-700">
          {memoryPermissions.isInitialLoading || roleAssignments.isInitialLoading ? (
            <p className="text-xs text-secondary-500">Loading members…</p>
          ) : memoryPermissions.isError ? (
            <ListError
              error={memoryPermissions.error}
              onRetry={memoryPermissions.refetch}
              className="px-0"
            />
          ) : roleAssignments.isError ? (
            <ListError
              error={roleAssignments.error}
              onRetry={roleAssignments.refetch}
              className="px-0"
            />
          ) : members.length === 0 ? (
            <p className="text-xs text-secondary-500">No members yet.</p>
          ) : (
            <ul className="divide-y divide-secondary-200 dark:divide-secondary-700">
              {members.map((member) => (
                <RecordRow
                  key={member.address}
                  title={truncateAddress(member.address)}
                  meta={[
                    member.roles.map((role) => humanizeKey(role)).join(', '),
                    permissionSummary(member.permissionMask),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  trailing={
                    <QuietChip tone={member.active ? 'neutral' : 'danger'}>
                      {member.active ? 'Active' : 'Inactive'}
                    </QuietChip>
                  }
                />
              ))}
            </ul>
          )}
          <LoadMoreRow list={memoryPermissions} className="px-0" showCompleteCount={false} />
          <LoadMoreRow list={roleAssignments} className="px-0" showCompleteCount={false} />
        </div>

        {groupId ? (
          <div className="mt-4 flex flex-col gap-3 border-t border-secondary-200 pt-4 dark:border-secondary-700">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Invitee address">
                <input
                  value={invitee}
                  onChange={(event) => setInvitee(event.target.value)}
                  placeholder="0x…"
                  className={`${fieldClass} w-full`}
                />
              </Field>
              <Field label="Role" hint="Used for invite, assign, and revoke.">
                <input
                  value={roleName}
                  onChange={(event) => setRoleName(event.target.value)}
                  placeholder="memory_administrator"
                  className={`${fieldClass} w-full`}
                />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run('invite', () =>
                    actions.inviteMember({
                      accountId: account.data!.account_id,
                      organizationId,
                      orgMemoryGroupId: groupId,
                      inviteeAddress: invitee.trim(),
                      roleName,
                      permissionsMask: DEFAULT_ORG_PERMS,
                      expiresAtMs: Date.now() + 7 * 24 * 60 * 60 * 1000,
                    }),
                  )
                }
                className={buttonClass}
              >
                {busy === 'invite' ? 'Inviting…' : 'Invite'}
              </button>
              <button
                type="button"
                disabled={Boolean(busy) || !memberFilter}
                onClick={() =>
                  void run('grant', () =>
                    actions.grantOrgMemory({
                      accountId: account.data!.account_id,
                      organizationId,
                      orgMemoryGroupId: groupId,
                      memberAddress: memberFilter!,
                      permissionsMask: DEFAULT_ORG_PERMS,
                    }),
                  )
                }
                className={buttonClass}
              >
                Grant memory
              </button>
              <button
                type="button"
                disabled={Boolean(busy) || !memberFilter}
                onClick={() =>
                  void run('revokeMem', () =>
                    actions.revokeOrgMemory({
                      accountId: account.data!.account_id,
                      organizationId,
                      orgMemoryGroupId: groupId,
                      memberAddress: memberFilter!,
                      permissionsMask: DEFAULT_ORG_PERMS,
                    }),
                  )
                }
                className={buttonClass}
              >
                Revoke memory
              </button>
              <button
                type="button"
                disabled={Boolean(busy) || !memberFilter}
                onClick={() =>
                  void run('role', () =>
                    actions.assignRole({
                      accountId: account.data!.account_id,
                      organizationId,
                      orgMemoryGroupId: groupId,
                      memberAddress: memberFilter!,
                      roleName,
                    }),
                  )
                }
                className={buttonClass}
              >
                Assign role
              </button>
              <button
                type="button"
                disabled={Boolean(busy) || !memberFilter}
                onClick={() =>
                  void run('revokeRole', () =>
                    actions.revokeRole({
                      accountId: account.data!.account_id,
                      organizationId,
                      orgMemoryGroupId: groupId,
                      memberAddress: memberFilter!,
                      roleName,
                    }),
                  )
                }
                className={buttonClass}
              >
                Revoke role
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-xs text-secondary-500">
            Enable shared memory before inviting members or granting permissions.
          </p>
        )}
      </section>

      <section className={`${cardClass} p-4`}>
        <h3 className={sectionTitleClass}>Roles</h3>
        <p className="mt-1 text-xs text-secondary-500">What each role is allowed to do.</p>
        <PeopleList
          title=""
          loading={roles.isInitialLoading}
          error={roles.isError ? roles.error : null}
          onRetry={roles.refetch}
          empty="No roles yet."
          footer={<LoadMoreRow list={roles} className="px-0" showCompleteCount={false} />}
        >
          {roles.items.map((role) => (
            <RecordRow
              key={role.role_name}
              title={humanizeKey(role.role_name)}
              meta={permissionSummary(role.mask)}
              trailing={
                <span className="flex shrink-0 gap-1">
                  {role.is_builtin ? <QuietChip>Built-in</QuietChip> : null}
                  <QuietChip tone={role.active ? 'neutral' : 'danger'}>
                    {role.active ? 'Active' : 'Inactive'}
                  </QuietChip>
                </span>
              }
            />
          ))}
        </PeopleList>
      </section>

      <ListSection
        title="Invitations"
        list={invitations}
        empty="No invitations yet."
        showCompleteCount={false}
        action={
          <select
            aria-label="Invitation status"
            value={invitationStatus}
            onChange={(event) => setInvitationStatus(event.target.value)}
            className={`${fieldClass} text-xs`}
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="accepted">Accepted</option>
            <option value="revoked">Revoked</option>
            <option value="expired">Expired</option>
          </select>
        }
      >
        <ul className="divide-y divide-secondary-200 dark:divide-secondary-700">
          {invitations.items.map((invitation) => (
            <RecordRow
              key={`${invitation.invitee_address}-${invitation.created_at_ms}`}
              title={truncateAddress(invitation.invitee_address)}
              meta={[
                invitation.role_name ? humanizeKey(invitation.role_name) : null,
                permissionSummary(invitation.permissions_mask),
                formatTimestamp(invitation.created_at_ms),
              ]
                .filter(Boolean)
                .join(' · ')}
              trailing={<QuietChip>{titleizeStatus(invitation.status)}</QuietChip>}
            />
          ))}
        </ul>
      </ListSection>

      <ListSection
        title="Spend approvals"
        list={approvals}
        empty="No spend approvals yet."
        showCompleteCount={false}
        action={
          <select
            aria-label="Approval status"
            value={approvalStatus}
            onChange={(event) => setApprovalStatus(event.target.value)}
            className={`${fieldClass} text-xs`}
          >
            <option value="">All statuses</option>
            <option value="requested">Requested</option>
            <option value="approved">Approved</option>
            <option value="consumed">Consumed</option>
            <option value="revoked">Revoked</option>
            <option value="expired">Expired</option>
          </select>
        }
      >
        <ul className="divide-y divide-secondary-200 dark:divide-secondary-700">
          {approvals.items.map((item) => (
            <RecordRow
              key={`${item.agent_object_id}-${item.requested_at}`}
              title={truncateAddress(item.agent_object_id)}
              meta={
                <>
                  Requested <MysoAmount amount={formatMistAmount(item.requested_amount_mist)} />
                </>
              }
              trailing={
                <span className="flex shrink-0 items-center gap-2">
                  <QuietChip>{titleizeStatus(item.status)}</QuietChip>
                  {credit.data && item.status !== 'approved' ? (
                    <button
                      type="button"
                      onClick={() =>
                        void run('approve', () =>
                          actions.approveSpend({
                            balanceId: credit.data!.balance.balance_id,
                            agentObjectId: item.agent_object_id,
                            maxAmountMist:
                              parseMysoToMist(approveMist) ??
                              BigInt(item.requested_amount_mist ?? 0),
                            expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
                            organizationId,
                          }),
                        )
                      }
                      className={buttonClass}
                    >
                      Approve
                    </button>
                  ) : null}
                </span>
              }
            />
          ))}
        </ul>
        <Field label="Approve amount (MySo)">
          <input
            value={approveMist}
            onChange={(event) => setApproveMist(event.target.value)}
            className={`${fieldClass} w-28`}
          />
        </Field>
      </ListSection>

      <ListSection
        title="Agent spend"
        list={spendBreakdown}
        empty="No recorded spend in this window."
        showCompleteCount={false}
        action={
          <select
            aria-label="Spend window"
            value={spendWindow}
            onChange={(event) =>
              setSpendWindow(event.target.value as 'days7' | 'days30' | 'days180' | 'all')
            }
            className={`${fieldClass} text-xs`}
          >
            <option value="days7">Last 7 days</option>
            <option value="days30">Last 30 days</option>
            <option value="days180">Last 180 days</option>
            <option value="all">All time</option>
          </select>
        }
      >
        <ul className="divide-y divide-secondary-200 dark:divide-secondary-700">
          {spendBreakdown.items.map((entry) => (
            <RecordRow
              key={entry.agent_object_id}
              title={entry.label}
              meta={`${entry.usage_events} events`}
              trailing={
                <span className="shrink-0 text-sm text-secondary-900 dark:text-secondary-50">
                  <MysoAmount amount={formatMistAmount(entry.spent_mist)} />
                </span>
              }
            />
          ))}
        </ul>
      </ListSection>

      <section className={`${cardClass} p-4`}>
        <div className="flex flex-wrap items-end gap-2">
          <h3 className={`min-w-0 flex-1 ${sectionTitleClass}`}>Audit log</h3>
          <Field label="Action">
            <input
              value={auditAction}
              onChange={(event) => setAuditAction(event.target.value)}
              placeholder="grant_role"
              className={`${fieldClass} w-36 text-xs`}
            />
          </Field>
          <Field label="Actor">
            <input
              value={auditActor}
              onChange={(event) => setAuditActor(event.target.value)}
              placeholder="0x…"
              className={`${fieldClass} w-48 text-xs`}
            />
          </Field>
        </div>
        {auditLogs.isInitialLoading ? (
          <p className="mt-3 text-xs text-secondary-500">Loading audit log…</p>
        ) : auditLogs.isError && isForbidden(auditLogs.error) ? (
          <p className="mt-3 text-xs text-secondary-500">
            Audit logs need auditor access for this organization. Ask an organization owner to
            grant it.
          </p>
        ) : auditLogs.isError ? (
          <ListError error={auditLogs.error} onRetry={auditLogs.refetch} className="mt-2 px-0" />
        ) : auditLogs.items.length === 0 ? (
          <p className="mt-3 text-xs text-secondary-500">No audit entries yet.</p>
        ) : (
          <>
            <ul className="mt-2 divide-y divide-secondary-200 dark:divide-secondary-700">
              {auditLogs.items.map((entry) => (
                <RecordRow
                  key={entry.id}
                  title={`${humanizeKey(entry.action)} · ${humanizeKey(entry.source)}`}
                  meta={`${truncateAddress(entry.actor_address)} · ${humanizeKey(entry.target_type)} · ${formatTimestamp(entry.time)}`}
                />
              ))}
            </ul>
            <LoadMoreRow list={auditLogs} className="px-0" showCompleteCount={false} />
          </>
        )}
      </section>

      {error ? <p className="text-sm text-danger-500">{error}</p> : null}
    </div>
  );
}

function QuietChip({
  children,
  tone = 'neutral',
}: Readonly<{children: ReactNode; tone?: 'neutral' | 'danger'}>) {
  const toneClass =
    tone === 'danger'
      ? 'border-danger-300 text-danger-600 dark:border-danger-700 dark:text-danger-400'
      : 'border-secondary-200 bg-secondary-100 text-secondary-700 dark:border-secondary-700 dark:bg-secondary-800 dark:text-secondary-200';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneClass}`}>
      {children}
    </span>
  );
}

function RecordRow({
  title,
  meta,
  trailing,
}: Readonly<{title: string; meta?: ReactNode; trailing?: ReactNode}>) {
  return (
    <li className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm text-secondary-800 dark:text-secondary-100">{title}</p>
        {meta ? <p className="mt-0.5 text-xs text-secondary-500">{meta}</p> : null}
      </div>
      {trailing}
    </li>
  );
}

function Field({
  label,
  hint,
  children,
}: Readonly<{label: string; hint?: string; children: ReactNode}>) {
  return (
    <label className="flex flex-col gap-1.5 text-xs text-secondary-500">
      <span>{label}</span>
      {children}
      {hint ? <span className="text-secondary-400">{hint}</span> : null}
    </label>
  );
}

function PeopleList({
  title,
  loading,
  error,
  onRetry,
  empty,
  footer,
  children,
}: Readonly<{
  title: string;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  empty: string;
  footer: ReactNode;
  children: ReactNode;
}>) {
  const hasItems = Children.count(children) > 0;
  return (
    <div className={title ? 'border-t border-secondary-200 pt-3 dark:border-secondary-700' : 'mt-3'}>
      {title ? (
        <h4 className="text-xs font-medium tracking-wide text-secondary-500">{title}</h4>
      ) : null}
      {loading ? (
        <p className="mt-2 text-xs text-secondary-500">Loading…</p>
      ) : error ? (
        <ListError error={error} onRetry={onRetry} className="mt-1 px-0" />
      ) : !hasItems ? (
        <p className="mt-2 text-xs text-secondary-500">{empty}</p>
      ) : (
        <>
          <ul className="divide-y divide-secondary-200 dark:divide-secondary-700">{children}</ul>
          {footer}
        </>
      )}
    </div>
  );
}
