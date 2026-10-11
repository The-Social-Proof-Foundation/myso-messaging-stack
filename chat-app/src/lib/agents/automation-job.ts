/**
 * Turns the job form's plain choices ("every day at 9:00, look up X") into the engine's job payload.
 * Pure, so the schedule maths is unit-tested instead of discovered in production.
 */

import type {
  AutomationAction,
  AutomationTrigger,
  AutomationTriggerSet,
  CreateJobInput,
  MemoryActionConfig,
  TaskActionPolicy,
} from './automation-client';

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

// ============================================================
// Task market automation
//
// Each template is one trigger on a `task` event plus one action. The action is either a registered
// action the engine runs straight away (the owner's policy decides whether to), or a webhook that
// answers with the action to run. The job signs as a `task_worker` delegate, so the on-chain
// capability, spend cap and the delegate's action allowlist bound whatever the job does.
// ============================================================

export type KeeperDuty = 'expire_offers' | 'refund_missed_delivery' | 'release_to_seller';

/** What the owner wants an auto-accept job to require of an offer. Blank fields are not checked. */
export interface AcceptPolicyInput {
  minAmountMist?: string;
  maxAmountMist?: string;
  minDeliveryWindowMs?: string;
  maxOpenTasks?: string;
  /** 1000-5000: the buyer's own buyer-role score, in milli-stars. */
  minBuyerScoreMilli?: string;
  minBuyerCredibilityBps?: string;
  /** One address per entry. */
  allowedBuyerPrincipals?: string[];
  /** 64-character hex digests of scope documents the agent is willing to work from. */
  scopeDigestAllowlist?: string[];
}

export type TaskAutomationChoice =
  | {kind: 'auto_accept'; policy: AcceptPolicyInput}
  | {kind: 'task_worker'; webhookUrl: string; webhookSecret: string}
  | {kind: 'buyer_verifier'; webhookUrl: string; webhookSecret: string}
  | {kind: 'auto_review'; role: 'buyer' | 'seller'; stars: number}
  | {kind: 'keeper'; duty: KeeperDuty};

export const TASK_AUTOMATION_LABELS: Record<TaskAutomationChoice['kind'], string> = {
  auto_accept: 'Auto-accept offers that fit my rules',
  task_worker: 'Do the work and deliver (your endpoint decides)',
  buyer_verifier: 'Check deliveries, then settle or ask for a refund (your endpoint decides)',
  auto_review: 'Rate the other side after each settled task',
  keeper: 'Keep escrow moving (expire, refund, release)',
};

export const KEEPER_DUTY_LABELS: Record<KeeperDuty, string> = {
  expire_offers: 'Return escrow for offers nobody answered',
  refund_missed_delivery: 'Refund tasks the seller never delivered',
  release_to_seller: 'Pay the seller once the settle window and grace have passed',
};

/** Minimum webhook secret length; the engine enforces the same floor. */
export const MIN_WEBHOOK_SECRET = 16;

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{1,64}$/;

function eventTrigger(
  eventType: string,
  payloadFilter?: Record<string, unknown>,
): AutomationTriggerSet {
  const trigger: AutomationTrigger = {
    kind: 'event',
    event_family: 'task',
    event_type: eventType,
    ...(payloadFilter ? {payload_filter: payloadFilter} : {}),
  };
  // The relayer stamps the account and agent scope from the delegate, so a job cannot widen it.
  return {match_mode: 'any', evaluation_window_ms: 0, triggers: [trigger]};
}

function uintField(label: string, value: string | undefined, max?: bigint): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (!UINT.test(text)) throw new JobFormError(`${label} must be a whole number.`);
  if (max !== undefined && BigInt(text) > max) throw new JobFormError(`${label} is too large.`);
  return text;
}

/** Validate an auto-accept policy and put it in the engine's field names. */
export function acceptPolicyToConfig(input: AcceptPolicyInput): TaskActionPolicy {
  const policy: TaskActionPolicy = {};
  const minAmount = uintField('Minimum amount', input.minAmountMist);
  const maxAmount = uintField('Maximum amount', input.maxAmountMist);
  if (minAmount !== undefined) policy.min_amount_mist = minAmount;
  if (maxAmount !== undefined) policy.max_amount_mist = maxAmount;
  if (minAmount !== undefined && maxAmount !== undefined && BigInt(minAmount) > BigInt(maxAmount)) {
    throw new JobFormError('The minimum amount is above the maximum.');
  }
  const window = uintField('Minimum delivery window', input.minDeliveryWindowMs);
  if (window !== undefined) policy.min_delivery_window_ms = window;
  const open = uintField('Open task limit', input.maxOpenTasks);
  if (open !== undefined) policy.max_open_tasks = open;
  const score = uintField('Minimum buyer score', input.minBuyerScoreMilli, 5000n);
  if (score !== undefined) policy.min_buyer_score_milli = score;
  const credibility = uintField('Minimum buyer credibility', input.minBuyerCredibilityBps, 10_000n);
  if (credibility !== undefined) policy.min_buyer_credibility_bps = credibility;

  const buyers = (input.allowedBuyerPrincipals ?? []).map((a) => a.trim()).filter(Boolean);
  if (buyers.some((a) => !ADDRESS.test(a))) throw new JobFormError('A buyer address is not a valid 0x address.');
  if (buyers.length > 0) policy.allowed_buyer_principals = buyers;

  const digests = (input.scopeDigestAllowlist ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (digests.some((d) => !HEX_64.test(d))) throw new JobFormError('A scope digest must be 64 hex characters.');
  if (digests.length > 0) policy.scope_digest_allowlist = digests;
  return policy;
}

/** `https://worker.example.com/hook` as the webhook config the engine validates again. */
function webhookAction(
  url: string,
  secret: string,
  allowedActionIds: string[],
): AutomationAction {
  const trimmed = url.trim();
  let host: string;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') throw new Error('not https');
    host = parsed.hostname;
  } catch {
    throw new JobFormError('Enter the endpoint as a full https:// address.');
  }
  if (secret.trim().length < MIN_WEBHOOK_SECRET) {
    throw new JobFormError(`The signing secret needs at least ${MIN_WEBHOOK_SECRET} characters.`);
  }
  return {
    kind: 'webhook',
    config: {url: trimmed, secret: secret.trim(), allowed_hosts: [host], allowed_action_ids: allowedActionIds},
  };
}

const KEEPER: Record<KeeperDuty, {eventType: string; action: string; params: Record<string, unknown>}> = {
  expire_offers: {
    eventType: 'expired_offer_due',
    action: 'task.expire_offer.v1',
    params: {taskId: '{{event.payload.task_id}}'},
  },
  refund_missed_delivery: {
    eventType: 'refund_due',
    action: 'task.refund.v1',
    params: {taskId: '{{event.payload.task_id}}'},
  },
  release_to_seller: {
    eventType: 'release_due',
    action: 'task.release.v1',
    params: {
      taskId: '{{event.payload.task_id}}',
      buyerAccountId: '{{event.payload.buyer_account_id}}',
      sellerAccountId: '{{event.payload.seller_account_id}}',
    },
  },
};

/** The task actions a delegate must have been registered for to run this template. */
export function requiredTaskActions(choice: TaskAutomationChoice): string[] {
  switch (choice.kind) {
    case 'auto_accept':
      return ['task.accept.v1'];
    case 'task_worker':
      return ['task.deliver.v1'];
    case 'buyer_verifier':
      return ['task.settle.v1', 'task.propose_refund.v1'];
    case 'auto_review':
      return ['task.review.v1'];
    case 'keeper':
      return [KEEPER[choice.duty].action];
  }
}

/** The job a task automation template creates. Pure, so the shape is tested rather than discovered. */
export function buildTaskJobInput(args: {
  name: string;
  choice: TaskAutomationChoice;
  /** The agent that owns the job; the relayer only lets an agent schedule work for itself. */
  targetAgentObjectId: string;
  /** `delegate:<name>` of a `task_worker` delegate. */
  delegateKeyRef: string;
}): CreateJobInput {
  const name = args.name.trim();
  if (!name) throw new JobFormError('Give the job a name.');
  if (name.length > MAX_JOB_NAME) throw new JobFormError(`Keep the name under ${MAX_JOB_NAME} characters.`);
  if (!args.delegateKeyRef) throw new JobFormError('Choose a task worker delegate to run this job as.');

  const {choice} = args;
  let trigger_set: AutomationTriggerSet;
  let action: AutomationAction;

  switch (choice.kind) {
    case 'auto_accept': {
      const policy = acceptPolicyToConfig(choice.policy);
      trigger_set = eventTrigger('offered');
      action = {
        kind: 'registered_action',
        config: {
          action_id: 'task.accept.v1',
          // The terms digest comes from the event, so the job accepts exactly what was offered.
          params: {
            taskId: '{{event.payload.task_id}}',
            sellerAgentId: '{{event.payload.seller_agent_id}}',
            termsDigestHex: '{{event.payload.terms_digest}}',
          },
          ...(Object.keys(policy).length > 0 ? {policy} : {}),
        },
      };
      break;
    }
    case 'task_worker':
      trigger_set = eventTrigger('accepted', {party_role: 'seller'});
      action = webhookAction(choice.webhookUrl, choice.webhookSecret, ['task.deliver.v1']);
      break;
    case 'buyer_verifier':
      trigger_set = eventTrigger('delivered');
      action = webhookAction(choice.webhookUrl, choice.webhookSecret, [
        'task.settle.v1',
        'task.propose_refund.v1',
      ]);
      break;
    case 'auto_review': {
      if (!Number.isInteger(choice.stars) || choice.stars < 1 || choice.stars > 5) {
        throw new JobFormError('Pick a rating from 1 to 5 stars.');
      }
      trigger_set = eventTrigger('review_open', {party_role: choice.role});
      // A buyer rates the seller agent; a seller rates the buyer agent, or the buyer's principal when a
      // person bought directly (the engine leaves a null `buyer_agent_id` out of the params).
      const params =
        choice.role === 'buyer'
          ? {
              taskId: '{{event.payload.task_id}}',
              raterRole: 'buyer',
              stars: choice.stars,
              buyerAccountId: '{{event.payload.buyer_account_id}}',
              sellerAccountId: '{{event.payload.seller_account_id}}',
              sellerAgentId: '{{event.payload.seller_agent_id}}',
            }
          : {
              taskId: '{{event.payload.task_id}}',
              raterRole: 'seller',
              stars: choice.stars,
              buyerAccountId: '{{event.payload.buyer_account_id}}',
              sellerAgentId: '{{event.payload.seller_agent_id}}',
              buyerAgentId: '{{event.payload.buyer_agent_id}}',
            };
      action = {kind: 'registered_action', config: {action_id: 'task.review.v1', params}};
      break;
    }
    case 'keeper': {
      const duty = KEEPER[choice.duty];
      if (!duty) throw new JobFormError('Pick what the keeper should do.');
      trigger_set = eventTrigger(duty.eventType);
      action = {kind: 'registered_action', config: {action_id: duty.action, params: duty.params}};
      break;
    }
  }

  return {
    name,
    trigger_set,
    target_agent_object_id: args.targetAgentObjectId,
    target_agent_key_ref: args.delegateKeyRef,
    action,
    // Chain actions are bounded by the delegate's on-chain spend cap, not an AI-credit budget.
    max_mist_per_run: 0,
  };
}
