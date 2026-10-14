import {useEffect, useMemo} from 'react';
import {AlertTriangle, Fuel, Loader2, ShieldCheck, X} from 'lucide-react';

import {useAllSubAgents} from '../../hooks/agents/useSubAgents';
import type {PendingChatAction} from '../../hooks/agents/useAgentMemoryReply';
import {CAPABILITY_LABELS} from '../../lib/agents/capabilities';
import {Button} from '../Button';
import {AgentOrb} from './AgentOrb';

interface AgentActionPermissionDialogProps {
  pending: PendingChatAction | null;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
}

const sameId = (a: string, b: string) =>
  a.toLowerCase().replace(/^0x0*/, '') === b.toLowerCase().replace(/^0x0*/, '');

/**
 * Asks the owner before an agent's proposed write is signed, as a panel right above the composer
 * so the conversation stays in view. The agent only ever proposes; nothing runs until Approve,
 * and the X or Escape count as Deny.
 */
export function AgentActionPermissionDialog({
  pending,
  busy,
  onApprove,
  onDeny,
}: Readonly<AgentActionPermissionDialogProps>) {
  const agents = useAllSubAgents({enabled: Boolean(pending)});

  useEffect(() => {
    if (!pending || busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDeny();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, busy, onDeny]);

  const rows = useMemo(() => {
    if (!pending) return [];
    return pending.proposal.def.rows(pending.proposal.params).map(([label, value, agentId]) => {
      const named = agentId ? agents.items.find((row) => sameId(row.agent_object_id, agentId)) : undefined;
      return {label, value: named?.label?.trim() || value, detail: named ? value : null};
    });
  }, [pending, agents.items]);

  if (!pending) return null;
  const {proposal, agent} = pending;
  const {def, params} = proposal;
  const warning = def.warning?.(params) ?? null;

  return (
    <section
      role="alertdialog"
      aria-labelledby="agent-action-title"
      aria-describedby="agent-action-effect"
      className="max-h-[40vh] shrink-0 space-y-2 overflow-y-auto border-t border-secondary-200 bg-white px-4 py-2.5 dark:border-secondary-700 dark:bg-secondary-900"
    >
      <header className="flex items-center gap-2.5">
        <AgentOrb agentKey={agent.derived_address} size={26} label={agent.label} />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <h2
            id="agent-action-title"
            className="text-[14px] font-semibold leading-snug text-secondary-900 dark:text-secondary-50"
          >
            {def.title}
          </h2>
          <span className="truncate text-[11.5px] text-secondary-500 dark:text-secondary-400">
            {agent.label} asks for your approval
          </span>
        </div>
        <button
          type="button"
          onClick={onDeny}
          disabled={busy}
          aria-label="Deny"
          className="-mr-1 shrink-0 rounded-full p-1 text-secondary-400 transition-colors hover:bg-secondary-100 hover:text-secondary-600 disabled:opacity-50 dark:hover:bg-secondary-800 dark:hover:text-secondary-200"
        >
          <X className="h-[18px] w-[18px]" />
        </button>
      </header>

      <p id="agent-action-effect" className="text-[12.5px] leading-snug text-secondary-600 dark:text-secondary-300">
        {def.effect(params)}
      </p>

      {rows.length > 0 && (
        <dl className="divide-y divide-secondary-200 overflow-hidden rounded-lg border border-secondary-200 bg-secondary-50 dark:divide-secondary-700 dark:border-secondary-700 dark:bg-secondary-800/60">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline gap-3 px-3 py-1">
              <dt className="w-24 shrink-0 text-[11.5px] font-medium text-secondary-500 dark:text-secondary-400">
                {row.label}
              </dt>
              <dd className="min-w-0 flex-1 break-words text-[13px] leading-snug text-secondary-900 dark:text-secondary-100">
                {row.value}
                {row.detail && (
                  <span className="ml-2 font-mono text-[11px] text-secondary-400 dark:text-secondary-500">
                    {row.detail}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 space-y-0.5 text-[11.5px] leading-snug text-secondary-500 dark:text-secondary-400">
          {warning && (
            <p className="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{warning}</span>
            </p>
          )}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            {def.capability && (
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  Allowed by <span className="font-medium">{CAPABILITY_LABELS[def.capability]}</span>
                </span>
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <Fuel className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{def.signs ? 'Signed from your wallet, gas applies' : 'No transaction, no gas'}</span>
            </span>
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" onClick={onDeny} disabled={busy} className="min-w-[8rem] justify-center">
            Deny
          </Button>
          <Button onClick={onApprove} disabled={busy} className="min-w-[8rem] justify-center">
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                Working…
              </>
            ) : (
              'Approve'
            )}
          </Button>
        </div>
      </div>
    </section>
  );
}
