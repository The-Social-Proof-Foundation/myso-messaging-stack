import type {AutomationDelegate, AutomationJob} from './automation-client';
import {DELEGATE_MAX_TTL_MS} from './automation-delegate';
import {
  JobFormError,
  KEEPER_DUTY_LABELS,
  requiredTaskActions,
  type KeeperDuty,
  type TaskAutomationChoice,
} from './automation-job';
import {parseMysoToMist} from './format';

/** The rules an agent can set up for another from chat; each is a template the automation server runs. */
export type AutomationRule = 'auto_accept' | 'auto_review' | 'keeper';

export const AUTOMATION_RULES: readonly AutomationRule[] = ['auto_accept', 'auto_review', 'keeper'];
export const KEEPER_DUTIES = Object.keys(KEEPER_DUTY_LABELS) as KeeperDuty[];

export interface RuleParams {
  rule: AutomationRule;
  /** `auto_accept`: only offers within this MySo range. */
  minAmountMyso?: string;
  maxAmountMyso?: string;
  /** `auto_accept`: stop taking offers at this many open tasks. */
  maxOpenTasks?: number;
  /** `auto_review`: which side the agent rates as, and with how many stars. */
  role?: 'buyer' | 'seller';
  stars?: number;
  /** `keeper`: the housekeeping to run. */
  duty?: KeeperDuty;
}

/** How long a worker delegate the chat creates lives. Short, and revocable the moment you like. */
export const WORKER_DELEGATE_DAYS = 30;
export const WORKER_DELEGATE_TTL_MS = Math.min(WORKER_DELEGATE_DAYS * 86_400_000, DELEGATE_MAX_TTL_MS);
/**
 * Spending limit for a chat-created worker. The templates here accept, rate and keep escrow
 * moving: none of them spends the delegate's own funds, so the limit is the smallest the chain allows.
 */
export const WORKER_SPEND_LIMIT_MIST = '1';

function mist(label: string, myso: string | undefined): string | undefined {
  if (myso === undefined) return undefined;
  const value = parseMysoToMist(myso);
  if (value === null || value <= 0n) throw new JobFormError(`${label} must be a positive MySo amount.`);
  return value.toString();
}

/** The existing job template a chat request maps to. Throws `JobFormError` for an unusable request. */
export function ruleToChoice(params: RuleParams): TaskAutomationChoice {
  switch (params.rule) {
    case 'auto_accept': {
      const min = mist('The minimum amount', params.minAmountMyso);
      const max = mist('The maximum amount', params.maxAmountMyso);
      if (min !== undefined && max !== undefined && BigInt(min) > BigInt(max)) {
        throw new JobFormError('The minimum amount is above the maximum.');
      }
      return {
        kind: 'auto_accept',
        policy: {
          ...(min !== undefined ? {minAmountMist: min} : {}),
          ...(max !== undefined ? {maxAmountMist: max} : {}),
          ...(params.maxOpenTasks !== undefined ? {maxOpenTasks: String(params.maxOpenTasks)} : {}),
        },
      };
    }
    case 'auto_review':
      if (params.role !== 'buyer' && params.role !== 'seller') throw new JobFormError('Say which side rates: buyer or seller.');
      if (!params.stars) throw new JobFormError('Pick a rating from 1 to 5 stars.');
      return {kind: 'auto_review', role: params.role, stars: params.stars};
    case 'keeper':
      if (!params.duty || !KEEPER_DUTIES.includes(params.duty)) throw new JobFormError('Pick what the keeper should do.');
      return {kind: 'keeper', duty: params.duty};
  }
}

/** One plain sentence: what the agent will now do by itself. */
export function ruleSummary(params: RuleParams): string {
  switch (params.rule) {
    case 'auto_accept': {
      const range =
        params.minAmountMyso && params.maxAmountMyso
          ? `between ${params.minAmountMyso} and ${params.maxAmountMyso} MySo`
          : params.minAmountMyso
            ? `of at least ${params.minAmountMyso} MySo`
            : params.maxAmountMyso
              ? `of up to ${params.maxAmountMyso} MySo`
              : 'of any size';
      const cap = params.maxOpenTasks ? `, while it has fewer than ${params.maxOpenTasks} open tasks` : '';
      return `accept task offers ${range}${cap}`;
    }
    case 'auto_review':
      return `rate the other side ${params.stars}★ after each settled task, as the ${params.role}`;
    case 'keeper':
      return KEEPER_DUTY_LABELS[params.duty!]!.replace(/^./, (c) => c.toLowerCase());
  }
}

export function defaultJobName(params: RuleParams, agentLabel: string): string {
  const base =
    params.rule === 'auto_accept'
      ? 'Auto-accept offers'
      : params.rule === 'auto_review'
        ? 'Auto-review tasks'
        : 'Keep escrow moving';
  return `${base} (${agentLabel})`.slice(0, 80);
}

/** A delegate name the chain and the engine accept, tied to the agent so it is easy to find again. */
export function workerDelegateName(agentObjectId: string, attempt = 0): string {
  const id = agentObjectId.replace(/^0x/i, '').slice(0, 8).toLowerCase();
  return attempt > 0 ? `worker-${id}-${attempt + 1}` : `worker-${id}`;
}

/** A worker delegate that is allowed to run every action the rule needs, or null when none is. */
export function pickWorkerDelegate(
  delegates: readonly Pick<AutomationDelegate, 'delegate_class' | 'allowed_action_ids' | 'delegate_ref'>[],
  required: readonly string[],
): string | null {
  const match = delegates.find(
    (row) =>
      row.delegate_class === 'task_worker' &&
      required.every((action) => (row.allowed_action_ids ?? []).includes(action)),
  );
  return match?.delegate_ref ?? null;
}

export function requiredActionsFor(params: RuleParams): string[] {
  return requiredTaskActions(ruleToChoice(params));
}

/** One line per job for `list_automations`. */
export function formatJobs(
  jobs: readonly Pick<AutomationJob, 'name' | 'enabled' | 'action'>[],
  limit = 10,
): string {
  if (!jobs.length) return 'No automations are set up for that agent.';
  const lines = jobs.slice(0, limit).map((job) => {
    const what =
      job.action.kind === 'registered_action'
        ? job.action.config.action_id.replace(/^task\./, '').replace(/\.v\d+$/, '').replace(/_/g, ' ')
        : job.action.kind === 'webhook'
          ? 'webhook'
          : 'memory';
    return `• ${job.name} — ${job.enabled ? 'on' : 'off'} · ${what}`;
  });
  const more = jobs.length > limit ? `\n…and ${jobs.length - limit} more.` : '';
  return `Automations:\n${lines.join('\n')}${more}`;
}
