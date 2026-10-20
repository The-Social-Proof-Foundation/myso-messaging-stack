import {useMemo, useState} from 'react';

import {classifyTaskError} from '../../lib/agents/format-task-error';
import {truncateAddress} from '../../lib/agents/format';
import {
  DUTY_LABEL,
  MODEL_FAMILY_LABEL,
  SUBJECT_KIND_LABEL,
  hasJuryCapability,
  isSuspended,
} from '../../lib/agents/jury';
import type {JurorRosterInfo, SubAgentRow} from '../../lib/agents/social-api';
import {useJuryActions, useJurorDuties, useOwnerJurors, useSubAgents} from '../../hooks/agents';
import {isAutomationDelegateLabel} from '../../lib/agents/automation-delegate';
import {Button} from '../Button';
import {DialogSelect} from '../Dialog';
import {cardClass, sectionTitleClass} from './chrome';
import {ErrorNotice} from './ErrorNotice';

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function JurorRow({
  agent,
  entry,
  now,
  busy,
  onJoin,
  onLeave,
}: Readonly<{
  agent: SubAgentRow;
  entry: JurorRosterInfo | undefined;
  now: number;
  busy: boolean;
  onJoin: (agent: SubAgentRow, modelFamily: number) => void;
  onLeave: (agent: SubAgentRow) => void;
}>) {
  const [family, setFamily] = useState(0);
  const suspended = entry ? isSuspended(entry, now) : false;

  return (
    <li className="flex flex-wrap items-center gap-3 border-t border-secondary-100 px-4 py-3 first:border-t-0 dark:border-secondary-700">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-secondary-900 dark:text-secondary-100">{agent.label}</p>
        <p className="text-xs text-secondary-500 dark:text-secondary-400">
          {entry
            ? suspended
              ? `Paused for missed duties until ${formatTime(entry.suspendedUntilMs ?? now)}`
              : `On the roster · ${MODEL_FAMILY_LABEL[entry.modelFamily] ?? 'Other'}${entry.exempt ? ' · launch exemption' : ''}`
            : 'Not on the roster'}
          {entry?.dutyScore != null ? ` · duty score ${entry.dutyScore}` : ''}
          {entry && entry.strikes > 0 ? ` · ${entry.strikes} strike${entry.strikes === 1 ? '' : 's'}` : ''}
        </p>
      </div>
      {entry ? (
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => onLeave(agent)}>
          Leave roster
        </Button>
      ) : (
        <>
          <DialogSelect
            value={family}
            onChange={(event) => setFamily(Number(event.target.value))}
            disabled={busy}
            aria-label={`Model family for ${agent.label}`}
            className="mt-0"
          >
            {Object.entries(MODEL_FAMILY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </DialogSelect>
          <Button size="sm" disabled={busy} onClick={() => onJoin(agent, family)}>
            Join roster
          </Button>
        </>
      )}
    </li>
  );
}

/**
 * Juror duty. An agent that joins the roster is drafted at random for disputes it has no
 * stake in, and is paid an equal share of the case fee for taking part, whichever way it votes.
 * Nothing is deposited or at risk; missing duties only pauses the agent.
 */
export function JuryPanel() {
  const agents = useSubAgents(true);
  const roster = useOwnerJurors();
  const actions = useJuryActions();
  const [busyAgent, setBusyAgent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  const jurorAgents = useMemo(
    () => agents.agents.filter((agent) => hasJuryCapability(agent) && !isAutomationDelegateLabel(agent.label)),
    [agents.agents],
  );
  const without = agents.agents.length - jurorAgents.length;
  const entries = useMemo(
    () => new Map((roster.data ?? []).map((entry) => [entry.agentId, entry])),
    [roster.data],
  );
  const onRoster = useMemo(
    () => jurorAgents.filter((a) => entries.has(a.agent_object_id)).map((a) => a.agent_object_id),
    [jurorAgents, entries],
  );
  const duties = useJurorDuties(onRoster);
  const labelOf = (agentId: string) =>
    jurorAgents.find((a) => a.agent_object_id === agentId)?.label ?? truncateAddress(agentId);

  async function run(agent: SubAgentRow, work: () => Promise<unknown>) {
    setBusyAgent(agent.agent_object_id);
    setError(null);
    try {
      await work();
      await roster.refetch();
    } catch (err) {
      setError(classifyTaskError(err).message);
    } finally {
      setBusyAgent(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <div className={cardClass}>
        <h2 className={`${sectionTitleClass} px-4 pt-3`}>Your juror agents</h2>
        <p className="px-4 pb-2 pt-1 text-xs text-secondary-500 dark:text-secondary-400">
          Joining is free and nothing is staked. Jurors are drafted at random, never for a dispute
          they are part of, and every juror who votes on time is paid an equal share of the case
          fee, however they vote.
        </p>
        {agents.isInitialLoading ? <p className="px-4 py-3 text-xs text-secondary-500">Loading…</p> : null}
        {!agents.isInitialLoading && jurorAgents.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-secondary-500 dark:text-secondary-400">
            None of your agents can serve as a juror yet. An agent needs the juror capability.
          </p>
        ) : null}
        <ul>
          {jurorAgents.map((agent) => (
            <JurorRow
              key={agent.agent_object_id}
              agent={agent}
              entry={entries.get(agent.agent_object_id)}
              now={now}
              busy={busyAgent !== null}
              onJoin={(a, family) => void run(a, () => actions.joinRoster(a, family))}
              onLeave={(a) => void run(a, () => actions.leaveRoster(a))}
            />
          ))}
        </ul>
        {without > 0 && jurorAgents.length > 0 ? (
          <p className="border-t border-secondary-100 px-4 py-2 text-xs text-secondary-500 dark:border-secondary-700 dark:text-secondary-400">
            {without} other agent{without === 1 ? '' : 's'} cannot serve as a juror.
          </p>
        ) : null}
        {error ? <ErrorNotice className="m-4">{error}</ErrorNotice> : null}
      </div>

      <div className={cardClass}>
        <h2 className={`${sectionTitleClass} px-4 pt-3`}>Open duties</h2>
        <p className="px-4 pb-2 pt-1 text-xs text-secondary-500 dark:text-secondary-400">
          Votes are sealed until they are revealed, so what a juror decided stays private while a
          case is open.
        </p>
        {duties.isLoading ? <p className="px-4 py-3 text-xs text-secondary-500">Loading…</p> : null}
        {!duties.isLoading && duties.duties.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-secondary-500 dark:text-secondary-400">
            {onRoster.length === 0 ? 'Join the roster with an agent to be drafted.' : 'No open duties.'}
          </p>
        ) : null}
        <ul>
          {duties.duties.map((duty) => (
            <li
              key={`${duty.caseId}:${duty.round}:${duty.agentId}`}
              className="flex flex-wrap items-center gap-3 border-t border-secondary-100 px-4 py-3 first:border-t-0 dark:border-secondary-700"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm text-secondary-900 dark:text-secondary-100">
                  {duty.dutyKind ? DUTY_LABEL[duty.dutyKind] : 'Waiting for voting to open'}
                </p>
                <p className="text-xs text-secondary-500 dark:text-secondary-400">
                  {labelOf(duty.agentId)} · {SUBJECT_KIND_LABEL[duty.subjectKind] ?? 'Case'}{' '}
                  <span className="font-mono">{truncateAddress(duty.subjectId)}</span>
                  {duty.round > 0 ? ' · appeal round' : ''}
                </p>
              </div>
              {duty.deadlineMs != null ? (
                <span className="text-xs text-secondary-500 dark:text-secondary-400">
                  by {formatTime(duty.deadlineMs)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
