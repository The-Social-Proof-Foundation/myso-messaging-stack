import {useEffect, useMemo, useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';

import {CAP, CAPABILITY_LABELS, CAPABILITY_NAMES, CAPABILITY_PRESETS, presetForMask, registrationGrant} from '../../lib/agents/capabilities';
import {parseMysoToMist} from '../../lib/agents/format';
import type {SubAgentRow} from '../../lib/agents/social-api';
import {
  useAgentActions,
  useAiCreditBalance,
  useMemoryAccount,
  useOrganizations,
} from '../../hooks/agents';
import {useAllSubAgents} from '../../hooks/agents/useSubAgents';
import {Button} from '../Button';
import {useAgentVault} from '../../contexts/AgentKeyVaultContext';
import type {AgentKeyEnvelopeV1} from '@socialproof/memory';
import {dialogFieldClass} from '../Dialog';
import {ErrorNotice} from './ErrorNotice';
import {ParentGrantDialog} from './ParentGrantDialog';

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return left.replace(/^0x/i, '').toLowerCase() === right.replace(/^0x/i, '').toLowerCase();
}

interface AgentCreateFormProps {
  /** Pre-selects an organization (e.g. the one being viewed). */
  defaultOrganizationId?: string | null;
  onCreated?: (agentObjectId: string) => void;
  /** Dismissal: the Cancel button, or a successful create. Omit for a form that stays put. */
  onClose?: () => void;
  /** Lets a host (the modal) know a transaction is in flight. */
  onBusyChange?: (busy: boolean) => void;
  /** Data hooks stay idle until the form is visible; the modal passes its `open` flag. */
  enabled?: boolean;
}

/**
 * Root/child agent registration fields. One implementation so the New Agent dialog and the
 * organization chart's inline create card can never drift apart.
 */
export function AgentCreateForm({
  defaultOrganizationId = null,
  onCreated,
  onClose,
  onBusyChange,
  enabled = true,
}: Readonly<AgentCreateFormProps>) {
  const account = useMemoryAccount();
  const queryClient = useQueryClient();
  const orgs = useOrganizations(true, {enabled});
  const agents = useAllSubAgents({enabled});
  const credit = useAiCreditBalance();
  const actions = useAgentActions();
  const vault = useAgentVault();
  const [grantDialogOpen,setGrantDialogOpen] = useState(false);
  // Agents can always create children and delegate their selected capabilities.
  const allowDelegation = true;
  const [drafts,setDrafts] = useState<AgentKeyEnvelopeV1[]>([]);
  const [draftId,setDraftId] = useState('');

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
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [step, setStep] = useState<string | null>(null);
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
  const parent = parents.find((agent) => agent.agent_object_id === parentId);
  const parentGrant = parent
    ? registrationGrant({capabilities: parent.capabilities, delegatableCaps: parent.delegatable_caps}, mask)
    : null;
  const needsParentGrant = Boolean(parentGrant);

  useEffect(() => {
    if (!enabled || kind !== 'child' || parents.length !== 1) return;
    setParentId(parents[0]?.agent_object_id ?? '');
  }, [enabled, kind, parents]);

  // Follow the organization the host is showing: switching organizations (or reopening the modal
  // for another one) must not register into the previously viewed organization.
  useEffect(() => setOrganizationId(defaultOrganizationId ?? ''), [defaultOrganizationId]);

  useEffect(()=>setGrantDialogOpen(false),[mask,parentId]);

  // Resume an interrupted registration: once the keys are unlocked, load this organization's saved
  // incomplete setup and select it, so Create agent finishes it instead of registering a duplicate.
  const vaultReady = vault?.status === 'ready';
  useEffect(() => {
    if (!enabled || !vaultReady || !vault) return;
    let cancelled = false;
    vault.pending().then((found) => {
      if (cancelled) return;
      setDrafts(found);
      const mine = found.filter((d) => sameId(d.organizationId, selectedOrg));
      setDraftId((current) => current || (mine.length === 1 ? mine[0]!.keyId : ''));
    }).catch(() => {});
    return () => {cancelled = true;};
  }, [enabled, vaultReady, vault, selectedOrg]);

  function setWorking(working: boolean) {
    setBusy(working);
    onBusyChange?.(working);
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

  /**
   * A new agent changes the org chart, agent lists, credit balances, chats and the wallet. Refetch
   * all of them now, and once more shortly after because the indexer can trail the chain by a beat.
   */
  async function hydrateAfterCreate() {
    const refresh = () =>
      Promise.all([
        queryClient.invalidateQueries({queryKey: ['agents']}),
        queryClient.invalidateQueries({queryKey: ['myso-wallet-balance']}),
      ]);
    await refresh();
    setTimeout(() => void refresh(), 2500);
  }

  async function submit(approveParentGrant = false) {
    if (!account.data) {
      setError('A memory account is required. Create a MySocial profile first.');
      return;
    }
    setWorking(true);
    setError(null);
    try {
      if (!vault) throw new Error('Agent key custody is not enabled.');
      // Locked (idle lock, or an earlier unlock that was rate limited): unlock as part of creating.
      if (vault.status !== 'ready') {
        setStep('Unlocking agent keys…');
        await vault.unlock();
      }
      const draft = drafts.find(d=>d.keyId===draftId);
      if(draft && !sameId(draft.organizationId,selectedOrg)) throw new Error('Choose the original organization for this saved setup.');
      const delegatableCaps = allowDelegation ? mask : 0;
      const effectiveMask=allowDelegation?mask|CAP.AGENT_REGISTER:mask;
      if (kind === 'root') {
        if (!selectedOrg) throw new Error('Choose an organization.');
        const created = await actions.registerRootAgent({
          accountId: account.data.account_id,
          organizationId: selectedOrg,
          label: label.trim() || 'Agent',
          capabilities: effectiveMask,
          expiresAtMs: expiresAtMs(),
          draft, delegatableCaps,
          budget: budgetArgs(),
          onStep: setStep,
        });
        await hydrateAfterCreate();
        onCreated?.(created.agentObjectId);
      } else {
        const selectedParent: SubAgentRow | undefined = parents.find(
          (agent) => agent.agent_object_id === parentId,
        );
        if (!selectedParent) throw new Error('Choose a parent agent.');
        const created = await actions.registerChildAgent({
          accountId: account.data.account_id,
          organizationId: selectedParent.organization_id,
          parent: selectedParent,
          label: label.trim() || 'Child agent',
          capabilities: effectiveMask,
          expiresAtMs: expiresAtMs(),
          draft, delegatableCaps,
          approveParentGrant,
          budget: budgetArgs(),
          onStep: setStep,
        });
        await hydrateAfterCreate();
        onCreated?.(created.agentObjectId);
      }
      onClose?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStep(null);
      setWorking(false);
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (kind === 'child' && parent && needsParentGrant) {
          setGrantDialogOpen(true);
          return;
        }
        void submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        {vault?.status !== 'ready' ? <Button variant="secondary" size="sm" disabled={!vault || vault.status==='busy'} onClick={()=>void vault?.unlock().catch(e=>setError(e.message))}>{vault?.status==='busy' ? 'Unlocking…' : 'Unlock agent keys'}</Button> : <span role="status" className="text-xs text-secondary-500 dark:text-secondary-400">Agent keys unlocked</span>}
        <Button variant="secondary" size="sm" onClick={()=>void vault?.pending().then(setDrafts).catch(e=>setError(e.message))}>Load saved incomplete setups</Button>
      </div>
      {drafts.length ? <label className="block text-sm">Saved setup<select className={dialogFieldClass} value={draftId} onChange={e=>setDraftId(e.target.value)}>
        <option value="">New agent</option>{drafts.filter(d=>sameId(d.organizationId,selectedOrg)).map(d=><option key={d.keyId} value={d.keyId}>{d.derivedAddress.slice(0,14)}…</option>)}
      </select></label> : null}
      {agents.isLoading ? (
        <p className="text-sm text-secondary-500">Loading agents…</p>
      ) : kind === 'root' ? null : (
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
        <div className="mt-2 space-y-2">
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
        <p className="mt-2 text-xs text-secondary-500 dark:text-secondary-400">
          Messenger and Manager include messaging, which an agent chat needs.
        </p>
        <div className="mt-2 rounded-lg border border-secondary-300 dark:border-secondary-600">
          <button
            type="button"
            aria-expanded={permissionsOpen}
            aria-controls="agent-permissions"
            onClick={() => setPermissionsOpen((open) => !open)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-secondary-700 dark:text-secondary-300"
          >
            Permissions ({CAPABILITY_NAMES.filter((name) => mask & CAP[name]).length}/{CAPABILITY_NAMES.length})
            <span aria-hidden className={`text-xs transition-transform duration-200 ease-out ${permissionsOpen ? 'rotate-180' : ''}`}>▾</span>
          </button>
          <div
            id="agent-permissions"
            aria-hidden={!permissionsOpen}
            className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${permissionsOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
          >
            <div className="overflow-hidden">
              <div className="grid grid-cols-1 gap-1 border-t border-secondary-200 px-3 py-2 sm:grid-cols-2 dark:border-secondary-700">
                {CAPABILITY_NAMES.map((name) => (
                  <label key={name} className="flex items-center gap-2 text-sm text-secondary-700 dark:text-secondary-300">
                    <input
                      type="checkbox"
                      disabled={busy || !permissionsOpen}
                      checked={(mask & CAP[name]) !== 0}
                      onChange={(event) => setMask(event.target.checked ? mask | CAP[name] : mask & ~CAP[name])}
                    />
                    {CAPABILITY_LABELS[name]}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
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
        <ErrorNotice>{error}</ErrorNotice>
      ) : null}

      <div className="flex flex-col gap-2 pt-2">
        <button
          type="submit"
          disabled={busy || !account.data || !vault}
          aria-busy={busy}
          className={`inline-flex h-10 w-full items-center justify-center rounded-md bg-[#D6F59A] px-4 py-2 font-chakra text-sm font-medium text-black transition-[filter,colors] duration-200 ease-out hover:bg-[#D5F679] hover:brightness-[1.03] active:bg-[#C9E27F] ${
            busy
              ? 'cursor-progress'
              : 'disabled:cursor-not-allowed disabled:bg-secondary-200 disabled:text-secondary-500 disabled:hover:brightness-100 dark:disabled:bg-secondary-800 dark:disabled:text-secondary-500'
          }`}
        >
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-black/25 border-t-black" />
              {step ?? 'Creating agent…'}
            </span>
          ) : (
            'Create agent'
          )}
        </button>
      </div>
      {kind === 'child' && parent && parentGrant ? (
        <ParentGrantDialog
          open={grantDialogOpen}
          parent={parent}
          agents={agents.items}
          childLabel={label.trim() || 'Child agent'}
          grant={parentGrant}
          onCancel={() => setGrantDialogOpen(false)}
          onApprove={() => {
            setGrantDialogOpen(false);
            void submit(true);
          }}
        />
      ) : null}
    </form>
  );
}

interface AgentCreateCardProps {
  /** The organization whose chart is showing this card. */
  organizationId?: string | null;
  onCreated?: (agentObjectId: string) => void;
}

/** Inline, centered version of the New Agent dialog, shown by an organization with no agents. */
export function AgentCreateCard({organizationId = null, onCreated}: Readonly<AgentCreateCardProps>) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <section
        aria-label="Create the first agent"
        className="w-full max-w-lg rounded-xl border border-secondary-200 bg-white p-6 shadow-sm dark:border-secondary-700 dark:bg-secondary-900"
      >
        <h3 className="mb-6 text-center font-chakra text-xl font-semibold tracking-wide text-secondary-900 dark:text-secondary-100">
          Create the first agent
        </h3>
        <AgentCreateForm defaultOrganizationId={organizationId} onCreated={onCreated} />
      </section>
    </div>
  );
}
