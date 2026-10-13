import {useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';

import {buttonClass, fieldClass} from './chrome';
import type {SubAgentRow} from '../../lib/agents/social-api';
import {agentKeys} from '../../hooks/agents/query-keys';
import {useAutomationDelegates, useCreateAutomationJob} from '../../hooks/agents/useAutomationJobs';
import {delegateKeyRef} from '../../lib/agents/automation-delegate';
import {
  JURY_KEEPER_CRANK_LABELS,
  JUROR_AUTOMATION_LABELS,
  JobFormError,
  KEEPER_CRANK_KINDS,
  MIN_WEBHOOK_SECRET,
  buildJurorJobInput,
  buildKeeperJobInput,
  requiredJurorActions,
  requiredKeeperAction,
  type JurorAutomationChoice,
  type KeeperCrank,
} from '../../lib/agents/automation-job';

type JurorKind = JurorAutomationChoice['kind'];

const labelClass = 'flex flex-col gap-1 text-xs text-secondary-500';

/**
 * Jury automation: let a juror agent take its seats, judge and vote, and collect its fee, and let
 * a keeper run the cranks that keep every case moving, all without anyone at the keyboard.
 *
 * Jobs sign as a juror or jury keeper delegate. Those delegates spend nothing and expire on their
 * own, so the worst a leaked key can do is vote or crank as itself until it is revoked.
 */
export function JurorAutomationForm({agent}: Readonly<{agent: SubAgentRow}>) {
  const queryClient = useQueryClient();
  const {create, accountId, enabled} = useCreateAutomationJob(agent);
  const {query: delegates} = useAutomationDelegates(agent);
  const jurors = (delegates.data ?? []).filter((row) => row.delegate_class === 'juror');
  const keepers = (delegates.data ?? []).filter((row) => row.delegate_class === 'jury_keeper');

  const [name, setName] = useState('');
  const [role, setRole] = useState<'juror' | 'keeper'>('juror');
  const [delegate, setDelegate] = useState('');
  const [kind, setKind] = useState<JurorKind>('accept_duty');
  const [crank, setCrank] = useState<KeeperCrank>('select_due');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const pool = role === 'juror' ? jurors : keepers;
  const chosen = pool.find((row) => row.delegate_ref === delegate) ?? pool[0];

  async function submit() {
    if (!chosen) return;
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      const registered = chosen.allowed_action_ids ?? [];
      let input;
      if (role === 'juror') {
        const picked: JurorAutomationChoice =
          kind === 'judge' ? {kind, webhookUrl, webhookSecret} : {kind};
        const missing = requiredJurorActions(picked).filter((id) => !registered.includes(id));
        if (missing.length > 0) {
          throw new JobFormError(`"${chosen.delegate_ref}" is not registered to run ${missing.join(', ')}.`);
        }
        input = buildJurorJobInput({
          name,
          choice: picked,
          targetAgentObjectId: agent.agent_object_id,
          delegateKeyRef: delegateKeyRef(chosen.delegate_ref),
        });
      } else {
        const needed = requiredKeeperAction(crank);
        if (!registered.includes(needed)) {
          throw new JobFormError(`"${chosen.delegate_ref}" is not registered to run ${needed}.`);
        }
        input = buildKeeperJobInput({
          name,
          crank,
          targetAgentObjectId: agent.agent_object_id,
          delegateKeyRef: delegateKeyRef(chosen.delegate_ref),
        });
      }
      await create(input);
      setDone(`"${name.trim()}" is on. It acts the next time a matching jury event arrives.`);
      setName('');
      setWebhookSecret('');
      await queryClient.invalidateQueries({queryKey: agentKeys.automationJobs(accountId ?? '')});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (jurors.length === 0 && keepers.length === 0) {
    return (
      <div className="border-t border-secondary-100 px-4 py-4 dark:border-secondary-800">
        <h3 className="text-sm font-medium text-secondary-800 dark:text-secondary-100">Jury automation</h3>
        <p className="mt-1 text-xs text-secondary-500">
          Create a <strong>juror</strong> or <strong>jury keeper</strong> delegate below first. Jury
          jobs sign as one; both spend nothing and expire on their own.
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-secondary-100 px-4 py-4 dark:border-secondary-800">
      <h3 className="text-sm font-medium text-secondary-800 dark:text-secondary-100">Jury automation</h3>
      <p className="mt-1 text-xs text-secondary-500">
        Jury jobs run on the events a case sends the agent. A vote is always your own judgment: the
        engine only passes your endpoint's answer on, signed by the delegate.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          Name
          <input className={fieldClass} placeholder="Serve on juries" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className={labelClass}>
          I am setting up a
          <select
            className={fieldClass}
            value={role}
            onChange={(e) => {
              setRole(e.target.value as 'juror' | 'keeper');
              setDelegate('');
            }}
          >
            <option value="juror" disabled={jurors.length === 0}>
              juror
            </option>
            <option value="keeper" disabled={keepers.length === 0}>
              jury keeper
            </option>
          </select>
        </label>
        <label className={labelClass}>
          Runs as
          <select className={fieldClass} value={chosen?.delegate_ref ?? ''} onChange={(e) => setDelegate(e.target.value)}>
            {pool.map((row) => (
              <option key={row.delegate_ref} value={row.delegate_ref}>
                {row.delegate_ref}
              </option>
            ))}
          </select>
        </label>

        {role === 'juror' ? (
          <label className={labelClass}>
            What should it do?
            <select className={fieldClass} value={kind} onChange={(e) => setKind(e.target.value as JurorKind)}>
              {(Object.keys(JUROR_AUTOMATION_LABELS) as JurorKind[]).map((value) => (
                <option key={value} value={value}>
                  {JUROR_AUTOMATION_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className={labelClass}>
            Crank
            <select className={fieldClass} value={crank} onChange={(e) => setCrank(e.target.value as KeeperCrank)}>
              {KEEPER_CRANK_KINDS.map((value) => (
                <option key={value} value={value}>
                  {JURY_KEEPER_CRANK_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        )}

        {role === 'juror' && kind === 'judge' ? (
          <>
            <label className={`${labelClass} sm:col-span-2`}>
              Your juror runner (https only)
              <input className={fieldClass} placeholder="https://jury.example.com/webhook/engine" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
            </label>
            <label className={`${labelClass} sm:col-span-2`}>
              Signing secret (at least {MIN_WEBHOOK_SECRET} characters)
              <input className={fieldClass} type="password" autoComplete="off" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} />
            </label>
            <p className="text-xs text-secondary-500 sm:col-span-2">
              The runner starts judging when voting opens and answers a later reminder with your
              committed vote, then the reveal. Judging is too slow for one request, so most
              reminders get no answer.
            </p>
          </>
        ) : null}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button type="button" className={buttonClass} disabled={!enabled || busy || !chosen} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Turn on'}
        </button>
        {done ? <p className="text-xs text-emerald-600 dark:text-emerald-400">{done}</p> : null}
        {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      </div>
    </div>
  );
}
