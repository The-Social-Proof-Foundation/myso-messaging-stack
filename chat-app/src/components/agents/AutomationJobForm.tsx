import {useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';

import {buttonClass, fieldClass} from './chrome';
import type {SubAgentRow} from '../../lib/agents/social-api';
import {agentKeys} from '../../hooks/agents/query-keys';
import {useAutomationDelegates, useCreateAutomationJob} from '../../hooks/agents/useAutomationJobs';
import {delegateKeyRef} from '../../lib/agents/automation-delegate';
import {
  JobFormError,
  WEEKDAYS,
  buildJobInput,
  type ScheduleChoice,
  type TaskChoice,
} from '../../lib/agents/automation-job';

type ScheduleKind = ScheduleChoice['kind'];
type TaskKind = TaskChoice['kind'];

const labelClass = 'flex flex-col gap-1 text-xs text-secondary-500';

/**
 * Schedule a task: pick what to do, when, and which delegate runs it. The form only offers choices
 * the engine can honour; the job itself signs as the delegate, never as one of the owner's agents.
 */
export function AutomationJobForm({agent}: Readonly<{agent: SubAgentRow}>) {
  const queryClient = useQueryClient();
  const {create, accountId, enabled} = useCreateAutomationJob(agent);
  const {query: delegates} = useAutomationDelegates(agent);
  const delegateRows = delegates.data ?? [];

  const [name, setName] = useState('');
  const [delegate, setDelegate] = useState('');
  const [taskKind, setTaskKind] = useState<TaskKind>('recall');
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const [prefix, setPrefix] = useState('');
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>('daily');
  const [every, setEvery] = useState('1');
  const [unit, setUnit] = useState<'minutes' | 'hours'>('hours');
  const [time, setTime] = useState('09:00');
  const [day, setDay] = useState(1);
  const [spendCap, setSpendCap] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const chosenDelegate = delegate || delegateRows[0]?.delegate_ref || '';

  function schedule(): ScheduleChoice {
    if (scheduleKind === 'interval') return {kind: 'interval', every: Number(every), unit};
    if (scheduleKind === 'weekly') return {kind: 'weekly', day, time};
    return {kind: 'daily', time};
  }

  function task(): TaskChoice {
    if (taskKind === 'remember') return {kind: 'remember', text};
    if (taskKind === 'recall_then_remember') return {kind: 'recall_then_remember', query, prefix};
    return {kind: 'recall', query};
  }

  async function submit() {
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      const cap = spendCap.trim();
      if (cap && !/^\d+$/.test(cap)) throw new JobFormError('The spending cap must be a whole number of MIST.');
      await create(
        buildJobInput({
          name,
          schedule: schedule(),
          task: task(),
          targetAgentObjectId: agent.agent_object_id,
          delegateKeyRef: chosenDelegate ? delegateKeyRef(chosenDelegate) : '',
          maxMistPerRun: cap ? Number(cap) : 0,
        }),
      );
      setDone(`"${name.trim()}" is scheduled. It runs once on the next engine tick, then on its schedule.`);
      setName('');
      await queryClient.invalidateQueries({queryKey: agentKeys.automationJobs(accountId ?? '')});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (delegateRows.length === 0) {
    return (
      <div className="border-t border-secondary-100 px-4 py-4 dark:border-secondary-800">
        <h3 className="text-sm font-medium text-secondary-800 dark:text-secondary-100">Schedule a task</h3>
        <p className="mt-1 text-xs text-secondary-500">
          Create a delegate below first. A scheduled task runs as a delegate, never as your own agent.
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-secondary-100 px-4 py-4 dark:border-secondary-800">
      <h3 className="text-sm font-medium text-secondary-800 dark:text-secondary-100">Schedule a task</h3>
      <p className="mt-1 text-xs text-secondary-500">
        Times are your local time. A new task runs once right away, then on its schedule.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          Name
          <input className={fieldClass} placeholder="Morning brief" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className={labelClass}>
          Runs as
          <select className={fieldClass} value={chosenDelegate} onChange={(e) => setDelegate(e.target.value)}>
            {delegateRows.map((row) => (
              <option key={row.delegate_ref} value={row.delegate_ref}>
                {row.delegate_ref}
              </option>
            ))}
          </select>
        </label>

        <label className={labelClass}>
          Task
          <select className={fieldClass} value={taskKind} onChange={(e) => setTaskKind(e.target.value as TaskKind)}>
            <option value="recall">Look something up in memory</option>
            <option value="remember">Save a note to memory</option>
            <option value="recall_then_remember">Look something up, then save what it finds</option>
          </select>
        </label>
        {taskKind === 'remember' ? (
          <label className={labelClass}>
            Note to save
            <input className={fieldClass} placeholder="Weekly check-in happened" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        ) : (
          <label className={labelClass}>
            Look up
            <input className={fieldClass} placeholder="what changed since yesterday" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}
        {taskKind === 'recall_then_remember' ? (
          <label className={`${labelClass} sm:col-span-2`}>
            Start the saved note with
            <input className={fieldClass} placeholder="Daily digest:" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          </label>
        ) : null}

        <label className={labelClass}>
          When
          <select className={fieldClass} value={scheduleKind} onChange={(e) => setScheduleKind(e.target.value as ScheduleKind)}>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="interval">Every few minutes or hours</option>
          </select>
        </label>
        {scheduleKind === 'interval' ? (
          <div className="flex items-end gap-2">
            <label className={`${labelClass} w-24`}>
              Every
              <input className={fieldClass} inputMode="numeric" value={every} onChange={(e) => setEvery(e.target.value.trim())} />
            </label>
            <select className={fieldClass} value={unit} onChange={(e) => setUnit(e.target.value as 'minutes' | 'hours')} aria-label="Interval unit">
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            {scheduleKind === 'weekly' ? (
              <select className={fieldClass} value={day} onChange={(e) => setDay(Number(e.target.value))} aria-label="Day of the week">
                {WEEKDAYS.map((label, index) => (
                  <option key={label} value={index}>
                    {label}
                  </option>
                ))}
              </select>
            ) : null}
            <label className={labelClass}>
              At
              <input className={fieldClass} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          </div>
        )}

        <label className={labelClass}>
          Spend limit per run (MIST, optional)
          <input className={fieldClass} inputMode="numeric" placeholder="none" value={spendCap} onChange={(e) => setSpendCap(e.target.value.trim())} />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button type="button" className={buttonClass} disabled={!enabled || busy} onClick={() => void submit()}>
          {busy ? 'Scheduling…' : 'Schedule task'}
        </button>
        {done ? <p className="text-xs text-emerald-600 dark:text-emerald-400">{done}</p> : null}
        {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      </div>
    </div>
  );
}
