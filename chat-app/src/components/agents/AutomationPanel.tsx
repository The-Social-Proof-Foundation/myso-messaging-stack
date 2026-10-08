import {useEffect, useState} from 'react';

import {buttonClass, cardClass, fieldClass, sectionTitleClass} from './chrome';
import {AutomationDelegates} from './AutomationDelegates';
import {AutomationJobForm} from './AutomationJobForm';
import {ListError} from './ListStates';
import type {SubAgentRow} from '../../lib/agents/social-api';
import type {AutomationJob, AutomationRun} from '../../lib/agents/automation-client';
import {useSubAgents} from '../../hooks/agents/useSubAgents';
import {
  useAutomationHealth,
  useAutomationJobs,
  useAutomationRuns,
} from '../../hooks/agents/useAutomationJobs';

/**
 * Scheduled and event-triggered work for one agent.
 *
 * Lists the jobs, lets the owner schedule a new one (`AutomationJobForm`; ownership is stamped
 * from the caller's signature, never the form), and manages delegates, the scoped keys a job
 * signs with.
 */

function jobSchedule(job: AutomationJob): string {
  const triggers = job.trigger_set.triggers;
  if (triggers.length === 0) return 'no triggers';
  return triggers
    .map((trigger) => {
      if (trigger.kind === 'cron' && trigger.cron_expr) return `cron ${trigger.cron_expr}`;
      if (trigger.kind === 'interval' && trigger.interval_ms) {
        const seconds = Math.round(trigger.interval_ms / 1000);
        return seconds >= 60 ? `every ${Math.round(seconds / 60)}m` : `every ${seconds}s`;
      }
      if (trigger.kind === 'event') {
        return `${trigger.event_family ?? '?'}.${trigger.event_type ?? '?'}`;
      }
      return trigger.kind;
    })
    .join(', ');
}

function runTone(status: AutomationRun['status']): string {
  switch (status) {
    case 'succeeded':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'failed':
      return 'text-red-600 dark:text-red-400';
    case 'skipped':
      return 'text-amber-600 dark:text-amber-400';
    default:
      return 'text-secondary-500';
  }
}

function formatWhen(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * Why a run did not simply succeed.
 *
 * A skip is usually a policy decision (budget or credits) rather than a fault,
 * so it is labelled differently from a failure.
 */
function runDetail(run: AutomationRun): string | null {
  if (run.error) return run.error;
  if (run.status === 'skipped') return 'Skipped by preflight or budget';
  return null;
}

function RunList({agent, jobId}: Readonly<{agent: SubAgentRow; jobId: string}>) {
  const runs = useAutomationRuns(agent, jobId);

  if (runs.isLoading) {
    return <p className="px-4 pb-4 text-sm text-secondary-500">Loading runs…</p>;
  }
  if (runs.error) {
    return <ListError error={runs.error} onRetry={() => void runs.refetch()} className="px-4 pb-4" />;
  }
  if (!runs.data || runs.data.length === 0) {
    return (
      <p className="px-4 pb-4 text-sm text-secondary-500">
        No runs yet. A job with an interval or cron trigger runs on the engine's tick; an
        event-triggered job waits for an event.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-secondary-100 border-t border-secondary-100 dark:divide-secondary-800 dark:border-secondary-800">
      {runs.data.map((run) => (
        <li key={run.id} className="px-4 py-2 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className={`font-medium ${runTone(run.status)}`}>{run.status}</span>
            <span className="text-secondary-500">
              {run.attempt > 1 ? `${run.attempt} attempts · ` : ''}
              {formatWhen(run.started_at)}
            </span>
          </div>
          {runDetail(run) ? (
            <p className="mt-1 break-words text-secondary-600 dark:text-secondary-300">
              {runDetail(run)}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function AutomationPanel({agent: fixedAgent}: Readonly<{agent?: SubAgentRow | null}>) {
  // Without a caller-supplied agent this panel picks one itself, so it can be
  // dropped into a page that has no notion of a selected agent.
  const subAgents = useSubAgents(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const agents = subAgents.agents;
  useEffect(() => {
    if (fixedAgent || selectedId || agents.length === 0) return;
    setSelectedId(agents[0]!.agent_object_id);
  }, [agents, fixedAgent, selectedId]);

  const agent =
    fixedAgent ?? agents.find((row) => row.agent_object_id === selectedId) ?? null;

  const jobs = useAutomationJobs(agent);
  const health = useAutomationHealth(agent);
  const [openJobId, setOpenJobId] = useState<string | null>(null);

  // A panel dropping itself in needs a picker; one handed an agent does not.
  const picker = fixedAgent ? null : (
    <select
      className={fieldClass}
      value={selectedId ?? ''}
      onChange={(event) => {
        setSelectedId(event.target.value || null);
        setOpenJobId(null);
      }}
      aria-label="Agent to inspect automation for"
    >
      {agents.length === 0 ? <option value="">No agents</option> : null}
      {agents.map((row) => (
        <option key={row.agent_object_id} value={row.agent_object_id}>
          {row.label || row.agent_object_id}
        </option>
      ))}
    </select>
  );

  if (!agent) {
    return (
      <section className={`${cardClass}`}>
        <div className="flex items-center justify-between gap-3 p-4">
          <h2 className={sectionTitleClass}>Automation</h2>
          {picker}
        </div>
        <p className="px-4 pb-4 text-sm text-secondary-500">
          {subAgents.isInitialLoading
            ? 'Loading agents…'
            : 'No agents registered, so there is nothing scheduled yet.'}
        </p>
      </section>
    );
  }

  return (
    <section className={`${cardClass}`}>
      <div className="flex items-center justify-between gap-3 p-4">
        <h2 className={sectionTitleClass}>Automation</h2>
        <div className="flex items-center gap-3">
          {health.data ? (
            <span className="text-xs text-emerald-600 dark:text-emerald-400">
              engine {health.data.status}
            </span>
          ) : health.error ? (
            <span className="text-xs text-secondary-500">engine not reachable</span>
          ) : null}
          {picker}
        </div>
      </div>

      {/* A 503 means the relayer has no AUTOMATION_ENGINE_URL, which is a
          deployment gap rather than a bug in the job list. */}
      {health.error ? (
        <p className="px-4 pb-4 text-sm text-secondary-500">
          The automation engine is not configured on this relayer, so no jobs can be
          listed. Set <code>AUTOMATION_ENGINE_URL</code> on the memory relayer.
        </p>
      ) : jobs.isLoading ? (
        <p className="px-4 pb-4 text-sm text-secondary-500">Loading jobs…</p>
      ) : jobs.error ? (
        <ListError error={jobs.error} onRetry={() => void jobs.refetch()} className="px-4 pb-4" />
      ) : !jobs.data || jobs.data.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-secondary-500">
          No automation jobs for this account yet.
        </p>
      ) : (
        <ul className="divide-y divide-secondary-100 dark:divide-secondary-800">
          {jobs.data.map((job) => {
            const open = openJobId === job.id;
            return (
              <li key={job.id}>
                <div className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-secondary-800 dark:text-secondary-100">
                      {job.name}
                    </p>
                    <p className="mt-0.5 text-xs text-secondary-500">
                      {jobSchedule(job)} · {job.action.kind.replace(/_/g, ' ')}
                      {job.memory_scope ? ` · ${job.memory_scope}` : ''}
                      {job.max_mist_per_run > 0
                        ? ` · cap ${job.max_mist_per_run} mist/run`
                        : ''}
                    </p>
                    {job.action.config?.operation ? (
                      <p className="mt-0.5 text-xs text-secondary-400">
                        {job.action.config.operation}
                        {job.action.config.query ? `: ${job.action.config.query}` : ''}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => setOpenJobId(open ? null : job.id)}
                    aria-expanded={open}
                  >
                    {open ? 'Hide runs' : 'Runs'}
                  </button>
                </div>
                {open ? <RunList agent={agent} jobId={job.id} /> : null}
              </li>
            );
          })}
        </ul>
      )}

      {health.error ? null : <AutomationJobForm agent={agent} />}
      {health.error ? null : <AutomationDelegates agent={agent} />}
    </section>
  );
}
