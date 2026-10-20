import {Children, useMemo, useRef, useState, type ReactNode} from 'react';
import {ORG_PERM_MEMORY_READ, ORG_PERM_MEMORY_WRITE} from '@socialproof/memory/account';

import {Dialog} from '../Dialog';
import {Button} from '../Button';
import {ListError, LoadMoreRow} from './ListStates';
import {buttonClass, fieldClass} from './chrome';
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
  useOrgAuditLogs,
  useOrgInvitations,
  useOrgMemoryPermissions,
  useOrgRoleAssignments,
  useOrgRoles,
  useOrgSpendApprovals,
  useOrgSpendBreakdown,
} from '../../hooks/agents';

const DEFAULT_ORG_PERMS = ORG_PERM_MEMORY_READ | ORG_PERM_MEMORY_WRITE;

export type OrgTool = 'people' | 'roles' | 'invitations' | 'approvals' | 'spend' | 'audit';

const TITLES: Record<OrgTool, string> = {
  people: 'People',
  roles: 'Roles',
  invitations: 'Invitations',
  approvals: 'Spend approvals',
  spend: 'Agent spend',
  audit: 'Audit log',
};

export function OrganizationToolsDialog({
  tool,
  organizationId,
  onClose,
}: Readonly<{
  tool: OrgTool;
  organizationId: string;
  onClose: () => void;
}>) {
  return (
    <Dialog open title={TITLES[tool]} onClose={onClose} maxWidthClass="max-w-lg">
      <div className="max-h-[70vh] overflow-y-auto">
        {tool === 'people' ? <PeopleTool organizationId={organizationId} /> : null}
        {tool === 'roles' ? <RolesTool organizationId={organizationId} /> : null}
        {tool === 'invitations' ? <InvitationsTool organizationId={organizationId} /> : null}
        {tool === 'approvals' ? <ApprovalsTool organizationId={organizationId} /> : null}
        {tool === 'spend' ? <SpendTool organizationId={organizationId} /> : null}
        {tool === 'audit' ? <AuditTool organizationId={organizationId} /> : null}
      </div>
    </Dialog>
  );
}

function useOrgRun() {
  const account = useMemoryAccount();
  const actions = useAgentActions();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return {account, actions, busy, error, run};
}

function AccessNote({
  forbidden,
  organizationId,
  groupId,
}: Readonly<{forbidden: boolean; organizationId: string; groupId?: string | null}>) {
  const {account, actions, busy, run} = useOrgRun();
  const owner = useAuthenticatedAddress() ?? '';
  if (!forbidden) return null;
  return (
    <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40">
      <p className="text-xs text-amber-900 dark:text-amber-100">
        This wallet does not have dashboard access for the organization yet. Grant it once to load these lists.
      </p>
      <Button
        size="sm"
        className="mt-2"
        disabled={Boolean(busy) || !groupId || !account.data}
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
    </div>
  );
}

function PeopleTool({organizationId}: Readonly<{organizationId: string}>) {
  const org = useOrganization(organizationId);
  const {account, actions, busy, error, run} = useOrgRun();
  const [member, setMember] = useState('');
  const [invitee, setInvitee] = useState('');
  const [roleName, setRoleName] = useState('memory_administrator');
  const memberFilter = member.trim() || undefined;
  const filters = useMemo(() => ({member: memberFilter, activeOnly: false}), [memberFilter]);
  const memoryPermissions = useOrgMemoryPermissions(organizationId, filters);
  const roleAssignments = useOrgRoleAssignments(organizationId, filters);
  const members = useMemo(
    () => groupOrganizationMembers(memoryPermissions.items, roleAssignments.items),
    [memoryPermissions.items, roleAssignments.items],
  );
  const groupId = org.data?.org_memory_group_id;
  const forbidden = isForbidden(memoryPermissions.error) || isForbidden(roleAssignments.error);
  const membersLoading = memoryPermissions.isInitialLoading || roleAssignments.isInitialLoading;
  const formLoading = org.isLoading || account.isLoading;
  const firstLoad = useFirstLoad(membersLoading || formLoading);

  if (firstLoad && !forbidden) {
    return (
      <DialogLoading label="Loading people">
        <Pulse className="h-2.5 w-28 rounded-full" />
        <Pulse className="h-8 w-full rounded-md" delay={40} />
        <LoadingRows />
        <Pulse className="h-2.5 w-24 rounded-full" delay={80} />
        <Pulse className="h-8 w-full rounded-md" delay={120} />
        <Pulse className="h-2.5 w-16 rounded-full" delay={160} />
        <Pulse className="h-8 w-full rounded-md" delay={200} />
        <div className="flex flex-wrap gap-2">
          {['w-16', 'w-24', 'w-28', 'w-20', 'w-24'].map((width, index) => (
            <Pulse key={`${width}-${index}`} className={`h-8 rounded-md ${width}`} delay={240 + index * 40} />
          ))}
        </div>
      </DialogLoading>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <AccessNote forbidden={forbidden} organizationId={organizationId} groupId={groupId} />
      <Field label="Filter by member" hint="Grant, revoke, and role actions use this address.">
        <input value={member} onChange={(event) => setMember(event.target.value)} placeholder="0x…" className={`${fieldClass} w-full text-xs`} />
      </Field>
      {membersLoading ? (
        <LoadingBlock label="Loading members">
          <LoadingRows />
        </LoadingBlock>
      ) : memoryPermissions.isError && !forbidden ? (
        <ListError error={memoryPermissions.error} onRetry={memoryPermissions.refetch} className="px-0" />
      ) : members.length === 0 ? (
        <p className="text-xs text-secondary-500">No members yet.</p>
      ) : (
        <ul className="divide-y divide-secondary-200 dark:divide-secondary-700">
          {members.map((person) => (
            <RecordRow
              key={person.address}
              title={truncateAddress(person.address)}
              meta={[person.roles.map((role) => humanizeKey(role)).join(', '), permissionSummary(person.permissionMask)].filter(Boolean).join(' · ')}
            />
          ))}
        </ul>
      )}
      {formLoading && !groupId ? (
        <LoadingBlock label="Loading member actions">
          <Pulse className="h-2.5 w-24 rounded-full" />
          <Pulse className="h-8 w-full rounded-md" delay={40} />
          <Pulse className="h-2.5 w-16 rounded-full" delay={80} />
          <Pulse className="h-8 w-full rounded-md" delay={120} />
          <div className="flex flex-wrap gap-2">
            {['w-16', 'w-24', 'w-28'].map((width, index) => (
              <Pulse key={`${width}-${index}`} className={`h-8 rounded-md ${width}`} delay={160 + index * 40} />
            ))}
          </div>
        </LoadingBlock>
      ) : groupId && account.data ? (
        <>
          <Field label="Invitee address">
            <input value={invitee} onChange={(event) => setInvitee(event.target.value)} placeholder="0x…" className={`${fieldClass} w-full`} />
          </Field>
          <Field label="Role" hint="Used for invite, assign, and revoke.">
            <input value={roleName} onChange={(event) => setRoleName(event.target.value)} className={`${fieldClass} w-full`} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <ActionButton busy={busy === 'invite'} disabled={Boolean(busy)} onClick={() => void run('invite', () => actions.inviteMember({accountId: account.data!.account_id, organizationId, orgMemoryGroupId: groupId, inviteeAddress: invitee.trim(), roleName, permissionsMask: DEFAULT_ORG_PERMS, expiresAtMs: Date.now() + 7 * 24 * 60 * 60 * 1000}))}>Invite</ActionButton>
            <ActionButton busy={busy === 'grant'} disabled={Boolean(busy) || !memberFilter} onClick={() => void run('grant', () => actions.grantOrgMemory({accountId: account.data!.account_id, organizationId, orgMemoryGroupId: groupId, memberAddress: memberFilter!, permissionsMask: DEFAULT_ORG_PERMS}))}>Grant memory</ActionButton>
            <ActionButton busy={busy === 'revokeMem'} disabled={Boolean(busy) || !memberFilter} onClick={() => void run('revokeMem', () => actions.revokeOrgMemory({accountId: account.data!.account_id, organizationId, orgMemoryGroupId: groupId, memberAddress: memberFilter!, permissionsMask: DEFAULT_ORG_PERMS}))}>Revoke memory</ActionButton>
            <ActionButton busy={busy === 'role'} disabled={Boolean(busy) || !memberFilter} onClick={() => void run('role', () => actions.assignRole({accountId: account.data!.account_id, organizationId, orgMemoryGroupId: groupId, memberAddress: memberFilter!, roleName}))}>Assign role</ActionButton>
            <ActionButton busy={busy === 'revokeRole'} disabled={Boolean(busy) || !memberFilter} onClick={() => void run('revokeRole', () => actions.revokeRole({accountId: account.data!.account_id, organizationId, orgMemoryGroupId: groupId, memberAddress: memberFilter!, roleName}))}>Revoke role</ActionButton>
          </div>
        </>
      ) : (
        <p className="text-xs text-secondary-500">Enable shared memory before inviting members or granting permissions.</p>
      )}
      {error ? <p className="text-sm text-danger-500">{error}</p> : null}
    </div>
  );
}

function RolesTool({organizationId}: Readonly<{organizationId: string}>) {
  const roles = useOrgRoles(organizationId, {activeOnly: false});
  const org = useOrganization(organizationId);
  const forbidden = isForbidden(roles.error);
  const firstLoad = useFirstLoad(roles.isInitialLoading);
  return (
    <div>
      <AccessNote forbidden={forbidden} organizationId={organizationId} groupId={org.data?.org_memory_group_id} />
      {firstLoad && !forbidden ? (
        <DialogLoading label="Loading roles">
          <Pulse className="h-3 w-52 rounded-full" />
          <LoadingRows />
        </DialogLoading>
      ) : (
        <>
      <p className="text-xs text-secondary-500">What each role is allowed to do.</p>
      <Rows
        loading={roles.isInitialLoading}
        error={roles.isError && !forbidden ? roles.error : null}
        onRetry={roles.refetch}
        empty="No roles yet."
        footer={<LoadMoreRow list={roles} className="px-0" showCompleteCount={false} />}
      >
        {roles.items.map((role) => (
          <RecordRow key={role.role_name} title={humanizeKey(role.role_name)} meta={permissionSummary(role.mask)} />
        ))}
      </Rows>
        </>
      )}
    </div>
  );
}

function InvitationsTool({organizationId}: Readonly<{organizationId: string}>) {
  const [status, setStatus] = useState('');
  const filters = useMemo(() => ({invitationStatus: status || undefined, activeOnly: false}), [status]);
  const invitations = useOrgInvitations(organizationId, filters);
  const org = useOrganization(organizationId);
  const loading = invitations.isInitialLoading;
  const firstLoad = useFirstLoad(loading);
  return (
    <div className="flex flex-col gap-3">
      <AccessNote forbidden={isForbidden(invitations.error)} organizationId={organizationId} groupId={org.data?.org_memory_group_id} />
      {firstLoad ? (
        <DialogLoading label="Loading invitations">
          <Pulse className="h-8 w-40 rounded-md" />
          <LoadingRows trailing />
        </DialogLoading>
      ) : (
        <>
      <select aria-label="Invitation status" value={status} onChange={(event) => setStatus(event.target.value)} className={`${fieldClass} text-xs`}>
        <option value="">All statuses</option>
        <option value="pending">Pending</option>
        <option value="accepted">Accepted</option>
        <option value="revoked">Revoked</option>
        <option value="expired">Expired</option>
      </select>
      <Rows loading={loading} trailing error={invitations.isError && !isForbidden(invitations.error) ? invitations.error : null} onRetry={invitations.refetch} empty="No invitations yet." footer={<LoadMoreRow list={invitations} className="px-0" showCompleteCount={false} />}>
        {invitations.items.map((invitation) => (
          <RecordRow
            key={`${invitation.invitee_address}-${invitation.created_at_ms}`}
            title={truncateAddress(invitation.invitee_address)}
            meta={[invitation.role_name ? humanizeKey(invitation.role_name) : null, permissionSummary(invitation.permissions_mask), formatTimestamp(invitation.created_at_ms)].filter(Boolean).join(' · ')}
            trailing={<span className="shrink-0 text-[11px] text-secondary-500">{titleizeStatus(invitation.status)}</span>}
          />
        ))}
      </Rows>
        </>
      )}
    </div>
  );
}

function ApprovalsTool({organizationId}: Readonly<{organizationId: string}>) {
  const [status, setStatus] = useState('');
  const [approveMist, setApproveMist] = useState('1');
  const filters = useMemo(() => ({approvalStatus: status || undefined, activeOnly: false}), [status]);
  const approvals = useOrgSpendApprovals(organizationId, filters);
  const credit = useAiCreditBalance();
  const {actions, busy, error, run} = useOrgRun();
  const org = useOrganization(organizationId);
  const loading = approvals.isInitialLoading;
  const firstLoad = useFirstLoad(loading);
  return (
    <div className="flex flex-col gap-3">
      <AccessNote forbidden={isForbidden(approvals.error)} organizationId={organizationId} groupId={org.data?.org_memory_group_id} />
      {firstLoad ? (
        <DialogLoading label="Loading spend approvals">
          <Pulse className="h-8 w-40 rounded-md" />
          <LoadingRows trailing />
          <Pulse className="h-2.5 w-36 rounded-full" />
          <Pulse className="h-8 w-28 rounded-md" delay={40} />
        </DialogLoading>
      ) : (
        <>
      <select aria-label="Approval status" value={status} onChange={(event) => setStatus(event.target.value)} className={`${fieldClass} text-xs`}>
        <option value="">All statuses</option>
        <option value="requested">Requested</option>
        <option value="approved">Approved</option>
        <option value="consumed">Consumed</option>
        <option value="revoked">Revoked</option>
        <option value="expired">Expired</option>
      </select>
      <Rows loading={approvals.isInitialLoading} trailing error={approvals.isError && !isForbidden(approvals.error) ? approvals.error : null} onRetry={approvals.refetch} empty="No spend approvals yet." footer={<LoadMoreRow list={approvals} className="px-0" showCompleteCount={false} />}>
        {approvals.items.map((item) => (
          <RecordRow
            key={`${item.agent_object_id}-${item.requested_at}`}
            title={truncateAddress(item.agent_object_id)}
            meta={<span>Requested <MysoAmount amount={formatMistAmount(item.requested_amount_mist)} /></span>}
            trailing={
              credit.data && item.status !== 'approved' ? (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run('approve', () =>
                      actions.approveSpend({
                        balanceId: credit.data!.balance.balance_id,
                        agentObjectId: item.agent_object_id,
                        maxAmountMist: parseMysoToMist(approveMist) ?? BigInt(item.requested_amount_mist ?? 0),
                        expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
                        organizationId,
                      }),
                    )
                  }
                >
                  {busy === 'approve' ? 'Approving…' : 'Approve'}
                </button>
              ) : (
                <span className="text-[11px] text-secondary-500">{titleizeStatus(item.status)}</span>
              )
            }
          />
        ))}
      </Rows>
      <Field label="Approve amount (MySo)">
        <input value={approveMist} onChange={(event) => setApproveMist(event.target.value)} className={`${fieldClass} w-28`} />
      </Field>
      {error ? <p className="text-sm text-danger-500">{error}</p> : null}
        </>
      )}
    </div>
  );
}

function SpendTool({organizationId}: Readonly<{organizationId: string}>) {
  const [window, setWindow] = useState<'days7' | 'days30' | 'days180' | 'all'>('days30');
  const filters = useMemo(() => ({spendWindow: window, activeOnly: false}), [window]);
  const spend = useOrgSpendBreakdown(organizationId, filters);
  const org = useOrganization(organizationId);
  const loading = spend.isInitialLoading;
  const firstLoad = useFirstLoad(loading);
  return (
    <div className="flex flex-col gap-3">
      <AccessNote forbidden={isForbidden(spend.error)} organizationId={organizationId} groupId={org.data?.org_memory_group_id} />
      {firstLoad ? (
        <DialogLoading label="Loading agent spend">
          <Pulse className="h-8 w-40 rounded-md" />
          <LoadingRows trailing />
        </DialogLoading>
      ) : (
        <>
      <select aria-label="Spend window" value={window} onChange={(event) => setWindow(event.target.value as typeof window)} className={`${fieldClass} text-xs`}>
        <option value="days7">Last 7 days</option>
        <option value="days30">Last 30 days</option>
        <option value="days180">Last 180 days</option>
        <option value="all">All time</option>
      </select>
      <Rows loading={loading} trailing error={spend.isError && !isForbidden(spend.error) ? spend.error : null} onRetry={spend.refetch} empty="No recorded spend in this window." footer={<LoadMoreRow list={spend} className="px-0" showCompleteCount={false} />}>
        {spend.items.map((entry) => (
          <RecordRow
            key={entry.agent_object_id}
            title={entry.label}
            meta={`${entry.usage_events} events`}
            trailing={<MysoAmount amount={formatMistAmount(entry.spent_mist)} />}
          />
        ))}
      </Rows>
        </>
      )}
    </div>
  );
}

function AuditTool({organizationId}: Readonly<{organizationId: string}>) {
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const filters = useMemo(
    () => ({audit: {action: action.trim() || undefined, actor: actor.trim() || undefined}, activeOnly: false}),
    [action, actor],
  );
  const audit = useOrgAuditLogs(organizationId, filters);
  const org = useOrganization(organizationId);
  const forbidden = isForbidden(audit.error);
  const loading = audit.isInitialLoading;
  const firstLoad = useFirstLoad(loading);
  return (
    <div className="flex flex-col gap-3">
      <AccessNote forbidden={forbidden} organizationId={organizationId} groupId={org.data?.org_memory_group_id} />
      {firstLoad && !forbidden ? (
        <DialogLoading label="Loading audit log">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Pulse className="h-2.5 w-14 rounded-full" />
              <Pulse className="h-8 rounded-md" delay={40} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Pulse className="h-2.5 w-12 rounded-full" delay={40} />
              <Pulse className="h-8 rounded-md" delay={80} />
            </div>
          </div>
          <LoadingRows />
        </DialogLoading>
      ) : (
        <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Action">
          <input value={action} onChange={(event) => setAction(event.target.value)} placeholder="grant_role" className={`${fieldClass} w-full text-xs`} />
        </Field>
        <Field label="Actor">
          <input value={actor} onChange={(event) => setActor(event.target.value)} placeholder="0x…" className={`${fieldClass} w-full text-xs`} />
        </Field>
      </div>
      {forbidden ? (
        <p className="text-xs text-secondary-500">Audit logs need auditor access for this organization.</p>
      ) : (
        <Rows loading={audit.isInitialLoading} error={audit.isError ? audit.error : null} onRetry={audit.refetch} empty="No audit entries yet." footer={<LoadMoreRow list={audit} className="px-0" showCompleteCount={false} />}>
          {audit.items.map((entry) => (
            <RecordRow
              key={entry.id}
              title={`${humanizeKey(entry.action)} · ${humanizeKey(entry.source)}`}
              meta={`${truncateAddress(entry.actor_address)} · ${humanizeKey(entry.target_type)} · ${formatTimestamp(entry.time)}`}
            />
          ))}
        </Rows>
      )}
        </>
      )}
    </div>
  );
}

function isForbidden(error: unknown): boolean {
  return error instanceof SocialServerError && (error.status === 403 || error.status === 401);
}

function ActionButton({
  children,
  busy,
  disabled,
  onClick,
}: Readonly<{children: string; busy: boolean; disabled: boolean; onClick: () => void}>) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={buttonClass}>
      {busy ? 'Working…' : children}
    </button>
  );
}

function Field({label, hint, children}: Readonly<{label: string; hint?: string; children: ReactNode}>) {
  return (
    <label className="flex flex-col gap-1.5 text-xs text-secondary-500">
      <span>{label}</span>
      {children}
      {hint ? <span className="text-secondary-400">{hint}</span> : null}
    </label>
  );
}

function RecordRow({title, meta, trailing}: Readonly<{title: string; meta?: ReactNode; trailing?: ReactNode}>) {
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

function Rows({
  loading,
  trailing = false,
  error,
  onRetry,
  empty,
  footer,
  children,
}: Readonly<{
  loading: boolean;
  trailing?: boolean;
  error: unknown;
  onRetry: () => void;
  empty: string;
  footer: ReactNode;
  children: ReactNode;
}>) {
  const hasItems = Children.count(children) > 0;
  if (loading) {
    return (
      <LoadingBlock label="Loading…">
        <LoadingRows trailing={trailing} />
      </LoadingBlock>
    );
  }
  if (error) return <ListError error={error} onRetry={onRetry} className="mt-2 px-0" />;
  if (!hasItems) return <p className="mt-2 text-xs text-secondary-500">{empty}</p>;
  return (
    <>
      <ul className="divide-y divide-secondary-200 dark:divide-secondary-700">{children}</ul>
      {footer}
    </>
  );
}

/** True only while the dialog has never finished its first load. Later filter changes keep the controls. */
function useFirstLoad(loading: boolean): boolean {
  const seen = useRef(false);
  if (!loading) seen.current = true;
  return loading && !seen.current;
}

function DialogLoading({label, children}: Readonly<{label: string; children: ReactNode}>) {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <p className="sr-only">{label}</p>
      <div aria-hidden className="flex flex-col gap-3">
        {children}
      </div>
    </div>
  );
}

function LoadingBlock({label, children}: Readonly<{label: string; children: ReactNode}>) {
  return (
    <div aria-busy="true">
      <p className="sr-only">{label}</p>
      <div aria-hidden>{children}</div>
    </div>
  );
}

function Pulse({className, delay = 0}: Readonly<{className: string; delay?: number}>) {
  return (
    <div
      className={`animate-pulse bg-secondary-200 dark:bg-secondary-700 ${className}`}
      style={{animationDelay: `${delay}ms`}}
    />
  );
}

const ROW_TITLE_WIDTHS = ['w-36', 'w-28', 'w-32'] as const;
const ROW_META_WIDTHS = ['w-52', 'w-40', 'w-44'] as const;

/** Placeholder rows matching RecordRow, using the same pulse as the members list. */
function LoadingRows({trailing = false}: Readonly<{trailing?: boolean}>) {
  return (
    <ul className="divide-y divide-secondary-200 dark:divide-secondary-700">
      {ROW_TITLE_WIDTHS.map((width, index) => (
        <li key={width} className="flex items-start justify-between gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <Pulse className={`h-3.5 rounded-full ${width}`} delay={index * 120} />
            <Pulse className={`mt-2 h-2.5 rounded-full ${ROW_META_WIDTHS[index]}`} delay={index * 120 + 40} />
          </div>
          {trailing ? <Pulse className="mt-0.5 h-3 w-16 rounded-full" delay={index * 120} /> : null}
        </li>
      ))}
    </ul>
  );
}
