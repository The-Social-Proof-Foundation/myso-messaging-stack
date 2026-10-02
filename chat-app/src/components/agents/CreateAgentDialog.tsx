import {useEffect, useMemo, useState} from 'react';

import {CAPABILITY_PRESETS, presetForMask} from '../../lib/agents/capabilities';
import {parseMysoToMist, truncateAddress} from '../../lib/agents/format';
import type {SubAgentRow} from '../../lib/agents/social-api';
import {
  useAgentActions,
  useAiCreditBalance,
  useMemoryAccount,
  useOrganizations,
} from '../../hooks/agents';
import {useAllSubAgents} from '../../hooks/agents/useSubAgents';
import {Button} from '../Button';
import {Dialog, dialogFieldClass} from '../Dialog';
import {ListError} from './ListStates';

interface CreateAgentDialogProps {
  open: boolean;
  onClose: () => void;
  /** Pre-selects an organization (e.g. the one being viewed). */
  defaultOrganizationId?: string | null;
  onCreated?: (agentObjectId: string) => void;
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return left.replace(/^0x/i, '').toLowerCase() === right.replace(/^0x/i, '').toLowerCase();
}

/** Modal form for registering a root or child agent. */
export function CreateAgentDialog({
  open,
  onClose,
  defaultOrganizationId = null,
  onCreated,
}: Readonly<CreateAgentDialogProps>) {
  const account = useMemoryAccount();
  const orgs = useOrganizations(true, {enabled: open});
  const agents = useAllSubAgents({enabled: open});
  const credit = useAiCreditBalance();
  const actions = useAgentActions();

  const [organizationId, setOrganizationId] = useState(defaultOrganizationId ?? '');
  const [parentId, setParentId] = useState('');
  const [label, setLabel] = useState('Chat assistant');
  // Messenger by default: agent chats need `CAP_MESSAGE_SEND`, which Chat assistant lacks.
  const [mask, setMask] = useState(
    CAPABILITY_PRESETS.find((preset) => preset.id === 'messenger')!.mask,
  );
  const [budget, setBudget] = useState('');
  const [expiryDays, setExpiryDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedOrg = organizationId || defaultOrganizationId || orgs.organizations[0]?.organization_id || '';
  const orgAgents = useMemo(
    () => agents.items.filter((agent) => sameId(agent.organization_id, selectedOrg)),
    [agents.items, selectedOrg],
  );
  const hasRoot = orgAgents.some((agent) => !agent.parent_object_id);
  const kind: 'root' | 'child' = !agents.isLoading && hasRoot ? 'child' : 'root';
  const parents = useMemo(
    () => orgAgents.filter((agent) => agent.active),
    [orgAgents],
  );
  const presetId = presetForMask(mask);

  useEffect(() => {
    if (!open || kind !== 'child' || parents.length !== 1) return;
    setParentId(parents[0]?.agent_object_id ?? '');
  }, [open, kind, parents]);

  function close() {
    if (busy) return;
    setError(null);
    onClose();
  }

  function budgetArgs() {
    const budgetMist = parseMysoToMist(budget);
    if (!credit.data || budgetMist == null) return undefined;
    return {
      balanceId: credit.data.balance.balance_id,
      budgetMist,
      dailyCapMist: null,
      monthlyCapMist: null,
      requireApprovalAboveMist: null,
    };
  }

  function expiresAtMs() {
    const days = Number(expiryDays);
    if (!Number.isFinite(days) || days <= 0) return null;
    return Date.now() + days * 24 * 60 * 60 * 1000;
  }

  async function submit() {
    if (!account.data) {
      setError('A memory account is required. Create a MySocial profile first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nextIndex = agents.totalCount ?? agents.items.length;
      if (kind === 'root') {
        if (!selectedOrg) throw new Error('Choose an organization.');
        const created = await actions.registerRootAgent({
          accountId: account.data.account_id,
          organizationId: selectedOrg,
          label: label.trim() || 'Agent',
          capabilities: mask,
          expiresAtMs: expiresAtMs(),
          nextIndex,
          budget: budgetArgs(),
        });
        onCreated?.(created.agentObjectId);
      } else {
        const parent: SubAgentRow | undefined = parents.find(
          (agent) => agent.agent_object_id === parentId,
        );
        if (!parent) throw new Error('Choose a parent agent.');
        const created = await actions.registerChildAgent({
          accountId: account.data.account_id,
          organizationId: parent.organization_id,
          parent,
          label: label.trim() || 'Child agent',
          capabilities: mask,
          expiresAtMs: expiresAtMs(),
          nextIndex,
          maxScanIndex: nextIndex,
          budget: budgetArgs(),
        });
        onCreated?.(created.agentObjectId);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="New Agent"
      onClose={close}
      busy={busy}
      maxWidthClass="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !account.data}>
            {busy ? 'Registering…' : 'Create agent'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {agents.isLoading ? (
          <p className="text-sm text-secondary-500">Loading agents…</p>
        ) : kind === 'root' ? (
          <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
            Organization
            <select
              value={selectedOrg}
              onChange={(event) => setOrganizationId(event.target.value)}
              disabled={busy || orgs.organizations.length === 0}
              className={`mt-1 ${dialogFieldClass}`}
            >
              {orgs.organizations.length === 0 ? <option value="">No organizations yet</option> : null}
              {orgs.organizations.map((org) => (
                <option key={org.organization_id} value={org.organization_id}>
                  {org.name || truncateAddress(org.organization_id)}
                </option>
              ))}
            </select>
            {orgs.isError ? (
              <ListError error={orgs.error} onRetry={orgs.refetch} className="mt-1 px-0" />
            ) : null}
          </label>
        ) : (
          <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
            Parent agent
            <select
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
              disabled={busy || parents.length === 0}
              className={`mt-1 ${dialogFieldClass}`}
            >
              <option value="">{parents.length === 0 ? 'No agents yet' : 'Select…'}</option>
              {parents.map((agent) => (
                <option key={agent.agent_object_id} value={agent.agent_object_id}>
                  {agent.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
          Name
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            disabled={busy}
            className={`mt-1 ${dialogFieldClass}`}
          />
        </label>

        <div>
          <span className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
            Abilities
          </span>
          <div className="mt-1 space-y-1.5">
            {CAPABILITY_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                disabled={busy}
                onClick={() => setMask(preset.mask)}
                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                  presetId === preset.id
                    ? 'border-secondary-400 bg-secondary-100 dark:border-secondary-500 dark:bg-secondary-800'
                    : 'border-secondary-300 hover:bg-secondary-50 dark:border-secondary-600 dark:hover:bg-secondary-700/50'
                }`}
              >
                <span className="block text-sm font-medium text-secondary-900 dark:text-secondary-100">
                  {preset.label}
                </span>
                <span className="block text-xs text-secondary-500 dark:text-secondary-400">
                  {preset.description}
                </span>
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-secondary-500 dark:text-secondary-400">
            Messenger and Manager include messaging, which an agent chat needs.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
            Budget (MySo, optional)
            <input
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              placeholder="none"
              disabled={busy}
              className={`mt-1 ${dialogFieldClass}`}
            />
          </label>
          <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
            Expires in days (optional)
            <input
              value={expiryDays}
              onChange={(event) => setExpiryDays(event.target.value)}
              placeholder="never"
              disabled={busy}
              className={`mt-1 ${dialogFieldClass}`}
            />
          </label>
        </div>

        {error ? (
          <p className="rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700 dark:border-danger-800 dark:bg-danger-950/40 dark:text-danger-300">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
