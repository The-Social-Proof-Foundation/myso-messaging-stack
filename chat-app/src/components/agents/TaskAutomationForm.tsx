import {useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';

import {buttonClass, fieldClass} from './chrome';
import type {SubAgentRow} from '../../lib/agents/social-api';
import {agentKeys} from '../../hooks/agents/query-keys';
import {useAutomationDelegates, useCreateAutomationJob} from '../../hooks/agents/useAutomationJobs';
import {delegateKeyRef} from '../../lib/agents/automation-delegate';
import {
  JobFormError,
  KEEPER_DUTY_LABELS,
  MIN_WEBHOOK_SECRET,
  TASK_AUTOMATION_LABELS,
  buildTaskJobInput,
  requiredTaskActions,
  type AcceptPolicyInput,
  type KeeperDuty,
  type TaskAutomationChoice,
} from '../../lib/agents/automation-job';

type Kind = TaskAutomationChoice['kind'];

const labelClass = 'flex flex-col gap-1 text-xs text-secondary-500';

const lines = (value: string): string[] =>
  value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * Task market automation: let an agent take offers, do the work, check deliveries, rate the other
 * side and keep escrow moving without anyone at the keyboard.
 *
 * Every job signs as a task worker delegate. The delegate's on-chain spend cap and its list of
 * allowed actions bound what a job can ever do, whatever its endpoint or rules say.
 */
export function TaskAutomationForm({agent}: Readonly<{agent: SubAgentRow}>) {
  const queryClient = useQueryClient();
  const {create, accountId, enabled} = useCreateAutomationJob(agent);
  const {query: delegates} = useAutomationDelegates(agent);
  const workers = (delegates.data ?? []).filter((row) => row.delegate_class === 'task_worker');

  const [name, setName] = useState('');
  const [delegate, setDelegate] = useState('');
  const [kind, setKind] = useState<Kind>('auto_accept');
  const [policy, setPolicy] = useState<Record<keyof AcceptPolicyInput, string>>({
    minAmountMist: '',
    maxAmountMist: '',
    minDeliveryWindowMs: '',
    maxOpenTasks: '',
    minBuyerScoreMilli: '',
    minBuyerCredibilityBps: '',
    allowedBuyerPrincipals: '',
    scopeDigestAllowlist: '',
  });
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [role, setRole] = useState<'buyer' | 'seller'>('seller');
  const [stars, setStars] = useState('5');
  const [duty, setDuty] = useState<KeeperDuty>('release_to_seller');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const chosen = workers.find((row) => row.delegate_ref === delegate) ?? workers[0];

  function choice(): TaskAutomationChoice {
    switch (kind) {
      case 'auto_accept':
        return {
          kind,
          policy: {
            ...policy,
            allowedBuyerPrincipals: lines(policy.allowedBuyerPrincipals),
            scopeDigestAllowlist: lines(policy.scopeDigestAllowlist),
          },
        };
      case 'task_worker':
      case 'buyer_verifier':
        return {kind, webhookUrl, webhookSecret};
      case 'auto_review':
        return {kind, role, stars: Number(stars)};
      case 'keeper':
        return {kind, duty};
    }
  }

  async function submit() {
    if (!chosen) return;
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      const picked = choice();
      const missing = requiredTaskActions(picked).filter(
        (id) => !(chosen.allowed_action_ids ?? []).includes(id),
      );
      if (missing.length > 0) {
        throw new JobFormError(`"${chosen.delegate_ref}" is not registered to run ${missing.join(', ')}.`);
      }
      await create(
        buildTaskJobInput({
          name,
          choice: picked,
          targetAgentObjectId: agent.agent_object_id,
          delegateKeyRef: delegateKeyRef(chosen.delegate_ref),
        }),
      );
      setDone(`"${name.trim()}" is on. It acts the next time a matching task event arrives.`);
      setName('');
      setWebhookSecret('');
      await queryClient.invalidateQueries({queryKey: agentKeys.automationJobs(accountId ?? '')});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (workers.length === 0) {
    return (
      <div className="border-t border-secondary-100 px-4 py-4 dark:border-secondary-800">
        <h3 className="text-sm font-medium text-secondary-800 dark:text-secondary-100">Task automation</h3>
        <p className="mt-1 text-xs text-secondary-500">
          Create a <strong>task worker</strong> delegate below first. Task jobs sign as one, so the
          most they can ever spend or do is what you grant it.
        </p>
      </div>
    );
  }

  const policyField = (key: keyof AcceptPolicyInput, label: string, placeholder: string) => (
    <label className={labelClass}>
      {label}
      <input
        className={fieldClass}
        placeholder={placeholder}
        value={policy[key]}
        onChange={(event) => setPolicy((current) => ({...current, [key]: event.target.value}))}
      />
    </label>
  );

  return (
    <div className="border-t border-secondary-100 px-4 py-4 dark:border-secondary-800">
      <h3 className="text-sm font-medium text-secondary-800 dark:text-secondary-100">Task automation</h3>
      <p className="mt-1 text-xs text-secondary-500">
        Rules run on the task events your agent receives. A job that does not fit its rules is
        skipped, not failed, and its run history says why.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          Name
          <input className={fieldClass} placeholder="Take small jobs" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className={labelClass}>
          Runs as
          <select className={fieldClass} value={chosen?.delegate_ref ?? ''} onChange={(e) => setDelegate(e.target.value)}>
            {workers.map((row) => (
              <option key={row.delegate_ref} value={row.delegate_ref}>
                {row.delegate_ref}
              </option>
            ))}
          </select>
        </label>
        <label className={`${labelClass} sm:col-span-2`}>
          What should it do?
          <select className={fieldClass} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {(Object.keys(TASK_AUTOMATION_LABELS) as Kind[]).map((value) => (
              <option key={value} value={value}>
                {TASK_AUTOMATION_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        {kind === 'auto_accept' ? (
          <>
            {policyField('minAmountMist', 'Smallest offer (MIST)', 'no minimum')}
            {policyField('maxAmountMist', 'Largest offer (MIST)', 'no maximum')}
            {policyField('minDeliveryWindowMs', 'Shortest delivery window (ms)', 'any')}
            {policyField('maxOpenTasks', 'Most tasks in progress at once', 'no limit')}
            {policyField('minBuyerScoreMilli', "Buyer's minimum score (1000-5000)", 'any')}
            {policyField('minBuyerCredibilityBps', "Buyer's minimum credibility (0-10000)", 'any')}
            <label className={`${labelClass} sm:col-span-2`}>
              Only these buyers (addresses, optional)
              <input
                className={fieldClass}
                placeholder="0x…, 0x…"
                value={policy.allowedBuyerPrincipals}
                onChange={(e) => setPolicy((current) => ({...current, allowedBuyerPrincipals: e.target.value}))}
              />
            </label>
            <label className={`${labelClass} sm:col-span-2`}>
              Only these scope documents (64-character digests, optional)
              <input
                className={fieldClass}
                placeholder="digest, digest"
                value={policy.scopeDigestAllowlist}
                onChange={(e) => setPolicy((current) => ({...current, scopeDigestAllowlist: e.target.value}))}
              />
            </label>
          </>
        ) : null}

        {kind === 'task_worker' || kind === 'buyer_verifier' ? (
          <>
            <label className={`${labelClass} sm:col-span-2`}>
              Your endpoint (https only)
              <input className={fieldClass} placeholder="https://agent.example.com/hook" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
            </label>
            <label className={`${labelClass} sm:col-span-2`}>
              Signing secret (at least {MIN_WEBHOOK_SECRET} characters)
              <input className={fieldClass} type="password" autoComplete="off" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} />
            </label>
            <p className="text-xs text-secondary-500 sm:col-span-2">
              {kind === 'task_worker'
                ? 'The engine sends the accepted task, signed with this secret. Reply with the deliverable and the job delivers it.'
                : 'The engine sends the delivery, signed with this secret. Reply to settle, ask for a refund, or do nothing. Doing nothing lets the seller be paid after the settle window and grace period.'}
            </p>
          </>
        ) : null}

        {kind === 'auto_review' ? (
          <>
            <label className={labelClass}>
              I am the
              <select className={fieldClass} value={role} onChange={(e) => setRole(e.target.value as 'buyer' | 'seller')}>
                <option value="seller">seller (rate the buyer)</option>
                <option value="buyer">buyer (rate the seller)</option>
              </select>
            </label>
            <label className={labelClass}>
              Stars
              <select className={fieldClass} value={stars} onChange={(e) => setStars(e.target.value)}>
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}

        {kind === 'keeper' ? (
          <label className={`${labelClass} sm:col-span-2`}>
            Duty
            <select className={fieldClass} value={duty} onChange={(e) => setDuty(e.target.value as KeeperDuty)}>
              {(Object.keys(KEEPER_DUTY_LABELS) as KeeperDuty[]).map((value) => (
                <option key={value} value={value}>
                  {KEEPER_DUTY_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button type="button" className={buttonClass} disabled={!enabled || busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Turn on'}
        </button>
        {done ? <p className="text-xs text-emerald-600 dark:text-emerald-400">{done}</p> : null}
        {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      </div>
    </div>
  );
}
