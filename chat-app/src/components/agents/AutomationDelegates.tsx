import {useState} from 'react';
import {Zap} from 'lucide-react';
import {useQueryClient} from '@tanstack/react-query';

import {buttonClass, fieldClass} from './chrome';
import {ListError} from './ListStates';
import type {SubAgentRow} from '../../lib/agents/social-api';
import {useAgentActions} from '../../hooks/agents/useAgentActions';
import {useAutomationDelegates} from '../../hooks/agents/useAutomationJobs';
import {agentKeys} from '../../hooks/agents/query-keys';
import {
  DELEGATE_MAX_TTL_MS,
  configuredMyDataKey,
  delegateKeyRef,
  isValidDelegateName,
} from '../../lib/agents/automation-delegate';

const DAY_MS = 24 * 60 * 60 * 1000;
const LIFETIMES = [1, 7, 30, 90] as const;

function myDataKeyConfigured(): boolean {
  try {
    return configuredMyDataKey() !== null;
  } catch {
    return false;
  }
}

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * Delegates: the only way an unattended job gets a signing key.
 *
 * A job never runs with this user's own agent keys. Creating a delegate
 * registers a new, memory-only, spend-capped, expiring sub-agent on-chain and
 * encrypts its key to the memory bridge in this browser. Revoking it on-chain
 * ends its authority at once.
 */
export function AutomationDelegates({agent}: Readonly<{agent: SubAgentRow}>) {
  const {query, client, accountId} = useAutomationDelegates(agent);
  const actions = useAgentActions();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [days, setDays] = useState<(typeof LIFETIMES)[number]>(30);
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);

  const organizationId = agent.organization_id ?? null;
  const ready = Boolean(client && accountId && organizationId) && myDataKeyConfigured();
  const nameOk = isValidDelegateName(name);
  const limitOk = /^[1-9][0-9]*$/.test(limit);

  const refresh = () =>
    queryClient.invalidateQueries({queryKey: agentKeys.automationDelegates(accountId ?? '')});

  async function create() {
    if (!client || !accountId || !organizationId) return;
    setError(null);
    setBusy('create');
    try {
      await actions.registerAutomationDelegate({
        accountId,
        organizationId,
        parent: agent,
        name,
        expiresAtMs: Date.now() + days * DAY_MS,
        maxActionSpendMist: limit,
        client,
        onStep: setStep,
      });
      setName('');
      setLimit('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setStep(null);
    }
  }

  async function revoke(delegateName: string, agentObjectId: string) {
    if (!client || !accountId) return;
    setError(null);
    setBusy(delegateName);
    try {
      await actions.revokeAutomationDelegate({
        accountId,
        agentObjectId,
        name: delegateName,
        client,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-t border-secondary-100 dark:border-secondary-800">
      <div className="px-4 pt-4">
        <h3 className="text-sm font-medium text-secondary-800 dark:text-secondary-100">
          Automation delegates
        </h3>
        <p className="mt-1 text-xs text-secondary-500">
          Scheduled jobs sign as a delegate, never as your own agents. A delegate can only read
          and write memory, can spend no more than its limit, expires on its own, and stops
          working the moment you revoke it.
        </p>
      </div>

      {query.isLoading ? (
        <p className="px-4 py-3 text-sm text-secondary-500">Loading delegates…</p>
      ) : query.error ? (
        <ListError error={query.error} onRetry={() => void query.refetch()} className="px-4 py-3" />
      ) : !query.data || query.data.length === 0 ? (
        <p className="px-4 py-3 text-sm text-secondary-500">No delegates yet.</p>
      ) : (
        <ul className="flex flex-col gap-2 px-4 py-3">
          {query.data.map((row) => (
            <li
              key={row.delegate_ref}
              className="flex items-center gap-3 rounded-xl border border-secondary-200 bg-secondary-50/60 px-3 py-2.5 dark:border-secondary-700 dark:bg-secondary-800/40"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-amber-600 dark:text-amber-300">
                <Zap className="size-4" strokeWidth={2} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-secondary-900 dark:text-secondary-50">
                    {row.delegate_ref}
                  </p>
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
                    Active
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-secondary-500">
                  <code className="rounded bg-secondary-200/60 px-1 py-0.5 dark:bg-secondary-700/60">
                    {delegateKeyRef(row.delegate_ref)}
                  </code>{' '}
                  · added {formatWhen(row.created_at)}
                </p>
              </div>
              <button
                type="button"
                className={buttonClass}
                disabled={busy !== null}
                onClick={() => void revoke(row.delegate_ref, row.agent_object_id)}
              >
                {busy === row.delegate_ref ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2 px-4 pb-4 pt-2">
        <input
          className={fieldClass}
          placeholder="Name (e.g. nightly)"
          value={name}
          onChange={(event) => setName(event.target.value.trim())}
          aria-label="Delegate name"
        />
        <select
          className={fieldClass}
          value={days}
          onChange={(event) => setDays(Number(event.target.value) as (typeof LIFETIMES)[number])}
          aria-label="Delegate lifetime"
        >
          {LIFETIMES.map((d) => (
            <option key={d} value={d}>
              expires in {d} day{d === 1 ? '' : 's'}
            </option>
          ))}
        </select>
        <input
          className={fieldClass}
          placeholder="Spending limit (MIST)"
          inputMode="numeric"
          value={limit}
          onChange={(event) => setLimit(event.target.value.trim())}
          aria-label="Delegate spending limit in MIST"
        />
        <button
          type="button"
          className={buttonClass}
          disabled={!ready || !nameOk || !limitOk || busy !== null}
          onClick={() => void create()}
        >
          {busy === 'create' ? (step ?? 'Creating…') : 'Create delegate'}
        </button>
      </div>

      {!myDataKeyConfigured() ? (
        <p className="px-4 pb-4 text-xs text-secondary-500">
          Delegates are not set up on this deployment: the memory bridge's public MyData key
          (<code>VITE_AUTOMATION_MYDATA_KEY</code>) is missing.
        </p>
      ) : !organizationId ? (
        <p className="px-4 pb-4 text-xs text-secondary-500">
          This agent is not part of an organization, so it cannot register a delegate.
        </p>
      ) : null}
      {error ? <p className="px-4 pb-4 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      <p className="px-4 pb-4 text-xs text-secondary-400">
        Lifetimes top out at {DELEGATE_MAX_TTL_MS / DAY_MS} days. Renew by creating a new one.
      </p>
    </div>
  );
}
