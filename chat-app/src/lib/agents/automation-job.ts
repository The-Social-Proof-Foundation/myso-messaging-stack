/**
 * Turns the job form's plain choices ("every day at 9:00, look up X") into the engine's job payload.
 * Pure, so the schedule maths is unit-tested instead of discovered in production.
 */

import type {AutomationTriggerSet, CreateJobInput, MemoryActionConfig} from './automation-client';

export type ScheduleChoice =
  | {kind: 'interval'; every: number; unit: 'minutes' | 'hours'}
  | {kind: 'daily'; time: string}
  | {kind: 'weekly'; day: number; time: string};

export type TaskChoice =
  | {kind: 'recall'; query: string}
  | {kind: 'remember'; text: string}
  | {kind: 'recall_then_remember'; query: string; prefix: string};

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** The engine evaluates time triggers on a 60 second tick, so nothing finer can run. */
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_JOB_NAME = 80;

export class JobFormError extends Error {}

function parseTime(time: string): {hour: number; minute: number} {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!match || hour > 23 || minute > 59) throw new JobFormError('Pick a valid time.');
  return {hour, minute};
}

/**
 * A local time and weekday as a UTC cron expression, which is what the engine evaluates.
 * `offsetMinutes` is `Date#getTimezoneOffset()` (UTC minus local), so it is injectable for tests.
 * The offset is fixed when the job is created, so a daylight-saving change moves the local time by an hour.
 */
export function localTimeToUtcCron(
  time: string,
  day: number | null,
  offsetMinutes: number,
): string {
  const {hour, minute} = parseTime(time);
  const total = hour * 60 + minute + offsetMinutes;
  const utcMinutes = ((total % 1440) + 1440) % 1440;
  const dayShift = Math.floor(total / 1440);
  const dow = day === null ? '*' : String((((day + dayShift) % 7) + 7) % 7);
  return `${utcMinutes % 60} ${Math.floor(utcMinutes / 60)} * * ${dow}`;
}

export function scheduleToTriggerSet(
  schedule: ScheduleChoice,
  offsetMinutes = new Date().getTimezoneOffset(),
): AutomationTriggerSet {
  const base = {event_family: 'automation', event_type: 'tick'};
  let trigger;
  if (schedule.kind === 'interval') {
    if (!Number.isInteger(schedule.every) || schedule.every < MIN_INTERVAL_MINUTES) {
      throw new JobFormError('Enter a whole number of minutes or hours.');
    }
    const minutes = schedule.unit === 'hours' ? schedule.every * 60 : schedule.every;
    trigger = {kind: 'interval' as const, interval_ms: minutes * 60_000, ...base};
  } else {
    const day = schedule.kind === 'weekly' ? schedule.day : null;
    if (day !== null && (!Number.isInteger(day) || day < 0 || day > 6)) {
      throw new JobFormError('Pick a day of the week.');
    }
    trigger = {
      kind: 'cron' as const,
      cron_expr: localTimeToUtcCron(schedule.time, day, offsetMinutes),
      ...base,
    };
  }
  return {match_mode: 'any', evaluation_window_ms: 0, triggers: [trigger]};
}

export function taskToAction(task: TaskChoice, keyRef: string): MemoryActionConfig {
  if (task.kind === 'recall') {
    if (!task.query.trim()) throw new JobFormError('Say what to look up.');
    return {operation: 'recall', key_ref: keyRef, query: task.query.trim(), limit: 10};
  }
  if (task.kind === 'remember') {
    if (!task.text.trim()) throw new JobFormError('Say what to save.');
    return {operation: 'remember', key_ref: keyRef, text: task.text.trim(), wait: true};
  }
  if (!task.query.trim()) throw new JobFormError('Say what to look up.');
  return {
    operation: 'recall_then_remember',
    key_ref: keyRef,
    query: task.query.trim(),
    remember_prefix: task.prefix.trim(),
    limit: 10,
    wait: true,
  };
}

export function buildJobInput(args: {
  name: string;
  schedule: ScheduleChoice;
  task: TaskChoice;
  /** The agent that owns the job; the relayer only lets an agent schedule work for itself. */
  targetAgentObjectId: string;
  /** `delegate:<name>`: the scoped key the job signs with. */
  delegateKeyRef: string;
  maxMistPerRun?: number;
  utcOffsetMinutes?: number;
}): CreateJobInput {
  const name = args.name.trim();
  if (!name) throw new JobFormError('Give the job a name.');
  if (name.length > MAX_JOB_NAME) throw new JobFormError(`Keep the name under ${MAX_JOB_NAME} characters.`);
  if (!args.delegateKeyRef) throw new JobFormError('Choose a delegate to run this job as.');
  return {
    name,
    trigger_set: scheduleToTriggerSet(args.schedule, args.utcOffsetMinutes),
    target_agent_object_id: args.targetAgentObjectId,
    target_agent_key_ref: args.delegateKeyRef,
    action: {kind: 'memory_relayer_call', config: taskToAction(args.task, args.delegateKeyRef)},
    max_mist_per_run: args.maxMistPerRun ?? 0,
  };
}
