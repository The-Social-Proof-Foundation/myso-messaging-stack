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
  family: 'task' | 'jury' = 'task',
): AutomationTriggerSet {
  const trigger: AutomationTrigger = {
    kind: 'event',
    event_family: family,
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

// ============================================================
// Jury automation
//
// A juror's jobs sign as a `juror` delegate and a keeper's as a `jury_keeper` delegate; both are
// zero-spend and expire on their own. Taking a seat and claiming the fee are registered actions the
// engine runs straight away. The vote itself is a judgment, so it goes to the owner's runner as a
// webhook: the runner answers the engine's reminders with `commit_vote`, and later `reveal_vote`,
// and the engine signs them as the delegate. A vote is never a registered action.
// ============================================================

export type JurorAutomationChoice =
  | {kind: 'accept_duty'}
  | {kind: 'claim_fee'}
  | {kind: 'judge'; webhookUrl: string; webhookSecret: string};

export const JUROR_AUTOMATION_LABELS: Record<JurorAutomationChoice['kind'], string> = {
  accept_duty: 'Accept every jury seat I am drafted for',
  claim_fee: 'Collect my juror fee when a case I served on closes',
  judge: 'Judge cases, then commit and reveal my vote (your runner decides)',
};

const JUROR_CASE_PARAMS = {
  caseId: '{{event.payload.case_id}}',
  agentId: '{{event.payload.agent_id}}',
};

/** The juror actions a delegate must have been registered for to run this template. */
export function requiredJurorActions(choice: JurorAutomationChoice): string[] {
  switch (choice.kind) {
    case 'accept_duty':
      return ['jury.accept.v1'];
    case 'claim_fee':
      return ['jury.claim_fee.v1'];
    case 'judge':
      return ['jury.commit_vote.v1', 'jury.reveal_vote.v1'];
  }
}

export function buildJurorJobInput(args: {
  name: string;
  choice: JurorAutomationChoice;
  /** The juror agent that owns the job; it must be the agent the delegate acts as. */
  targetAgentObjectId: string;
  /** `delegate:<name>` of a `juror` delegate. */
  delegateKeyRef: string;
}): CreateJobInput {
  const name = args.name.trim();
  if (!name) throw new JobFormError('Give the job a name.');
  if (name.length > MAX_JOB_NAME) throw new JobFormError(`Keep the name under ${MAX_JOB_NAME} characters.`);
  if (!args.delegateKeyRef) throw new JobFormError('Choose a juror delegate to run this job as.');

  const {choice} = args;
  let trigger_set: AutomationTriggerSet;
  let action: AutomationAction;
  switch (choice.kind) {
    case 'accept_duty': {
      // The draft is announced once, so a dropped event would leave the seat unfilled. The accept
      // reminder repeats until the seat is taken, and taking a seat twice is a harmless skip.
      const drafted = eventTrigger('duty_drafted', undefined, 'jury').triggers;
      const reminder = eventTrigger('duty_poll', {duty_kind: 'accept'}, 'jury').triggers;
      trigger_set = {match_mode: 'any', evaluation_window_ms: 0, triggers: [...drafted, ...reminder]};
      action = {kind: 'registered_action', config: {action_id: 'jury.accept.v1', params: JUROR_CASE_PARAMS}};
      break;
    }
    case 'claim_fee':
      trigger_set = eventTrigger('fee_claimable', undefined, 'jury');
      action = {kind: 'registered_action', config: {action_id: 'jury.claim_fee.v1', params: JUROR_CASE_PARAMS}};
      break;
    case 'judge': {
      // The runner starts judging on the first reminder and answers a later one with the vote. The
      // engine's webhook limit is 15 seconds, far too short to judge inside one call.
      const triggers: AutomationTrigger[] = ['voting_started', 'duty_poll'].map((eventType) => ({
        kind: 'event',
        event_family: 'jury',
        event_type: eventType,
      }));
      trigger_set = {match_mode: 'any', evaluation_window_ms: 0, triggers};
      action = webhookAction(choice.webhookUrl, choice.webhookSecret, [
        'jury.commit_vote.v1',
        'jury.reveal_vote.v1',
      ]);
      break;
    }
  }

  return {
    name,
    trigger_set,
    target_agent_object_id: args.targetAgentObjectId,
    target_agent_key_ref: args.delegateKeyRef,
    action,
    // A juror delegate cannot spend, so a job has no budget to bound.
    max_mist_per_run: 0,
  };
}

/** One crank a keeper can be set to run whenever the chain says it is due. */
export type KeeperCrank =
  | 'select_due'
  | 'replace_due'
  | 'round_finalize_due'
  | 'case_finalize_due'
  | 'execute_ready'
  | 'neutral_start_due'
  | 'neutral_due'
  | 'fees_due'
  | 'escalate_due'
  | 'proposal_finalize_due'
  | 'apply_ready'
  | 'roster_refresh_due'
  | 'evict_due'
  | 'sweep_due';

export const JURY_KEEPER_CRANK_LABELS: Record<KeeperCrank, string> = {
  select_due: 'Draw a jury once evidence closes',
  replace_due: 'Replace jurors who did not accept in time',
  round_finalize_due: 'Close a voting round when it ends',
  case_finalize_due: 'Finalize a case once the appeal window passes',
  execute_ready: 'Carry out a task verdict',
  neutral_start_due: 'Open the settlement window after a failed jury',
  neutral_due: 'Split the escrow when the settlement window ends',
  fees_due: 'Pay jurors and settle dispute fees',
  escalate_due: 'Send a proposal to the jury when it is due',
  proposal_finalize_due: 'End a community vote so a stalled one can reach the jury',
  apply_ready: "Apply the jury's decision to its proposal",
  roster_refresh_due: "Refresh a juror's eligibility snapshot",
  evict_due: 'Remove a juror who can no longer serve',
  sweep_due: "Return a closed governance case's unclaimed juror fees",
};

const CASE_ID = '{{event.payload.case_id}}';
const TASK_ID = '{{event.payload.task_id}}';
const TASK_ACCOUNTS = {
  buyerAccountId: '{{event.payload.buyer_account_id}}',
  sellerAccountId: '{{event.payload.seller_account_id}}',
  // Null for a task on the default platform, and the engine leaves a null parameter out.
  platformObjectId: '{{event.payload.platform_object_id}}',
};
const PROPOSAL = {
  registryId: '{{event.payload.registry_id}}',
  proposalId: '{{event.payload.proposal_id}}',
  platformId: '{{event.payload.platform_id}}',
};

const KEEPER_CRANKS: Record<KeeperCrank, {action: string; params: Record<string, unknown>}> = {
  select_due: {action: 'jury.select_jury.v1', params: {caseId: CASE_ID}},
  replace_due: {action: 'jury.replace_no_shows.v1', params: {caseId: CASE_ID}},
  round_finalize_due: {action: 'jury.finalize_round.v1', params: {caseId: CASE_ID}},
  case_finalize_due: {action: 'jury.finalize_case.v1', params: {caseId: CASE_ID}},
  execute_ready: {
    action: 'jury.execute_task_verdict.v1',
    params: {taskId: TASK_ID, caseId: CASE_ID, ...TASK_ACCOUNTS},
  },
  neutral_start_due: {
    action: 'jury.start_neutral_resolution.v1',
    params: {taskId: TASK_ID, caseId: CASE_ID},
  },
  neutral_due: {action: 'jury.execute_neutral_resolution.v1', params: {taskId: TASK_ID, ...TASK_ACCOUNTS}},
  fees_due: {
    action: 'jury.settle_dispute_fees.v1',
    params: {taskId: TASK_ID, caseId: CASE_ID, closeCaseFirst: '{{event.payload.close_case_first}}'},
  },
  escalate_due: {
    action: 'jury.escalate_proposal.v1',
    params: {...PROPOSAL, stage: '{{event.payload.stage}}'},
  },
  proposal_finalize_due: {action: 'jury.finalize_proposal.v1', params: PROPOSAL},
  apply_ready: {action: 'jury.apply_proposal_decision.v1', params: {...PROPOSAL, caseId: CASE_ID}},
  roster_refresh_due: {
    action: 'jury.refresh_roster_entry.v1',
    params: {accountId: '{{event.payload.memory_account_id}}', agentId: '{{event.payload.agent_id}}'},
  },
  evict_due: {action: 'jury.evict_ineligible.v1', params: {agentId: '{{event.payload.agent_id}}'}},
  sweep_due: {action: 'jury.sweep_case.v1', params: {caseId: CASE_ID}},
};

export const KEEPER_CRANK_KINDS = Object.keys(KEEPER_CRANKS) as KeeperCrank[];

/** The keeper action a crank runs; a delegate must be registered for it. */
export function requiredKeeperAction(crank: KeeperCrank): string {
  return KEEPER_CRANKS[crank].action;
}

/**
 * The job that runs one crank. Keeper events are addressed to the keeper's own account, so the
 * trigger carries no agent filter: the job cannot, and need not, narrow it further.
 */
export function buildKeeperJobInput(args: {
  name: string;
  crank: KeeperCrank;
  targetAgentObjectId: string;
  /** `delegate:<name>` of a `jury_keeper` delegate. */
  delegateKeyRef: string;
}): CreateJobInput {
  const name = args.name.trim();
  if (!name) throw new JobFormError('Give the job a name.');
  if (name.length > MAX_JOB_NAME) throw new JobFormError(`Keep the name under ${MAX_JOB_NAME} characters.`);
  if (!args.delegateKeyRef) throw new JobFormError('Choose a jury keeper delegate to run this job as.');
  const template = KEEPER_CRANKS[args.crank];
  if (!template) throw new JobFormError('Pick which crank the keeper should run.');
  return {
    name,
    trigger_set: eventTrigger(args.crank, undefined, 'jury'),
    target_agent_object_id: args.targetAgentObjectId,
    target_agent_key_ref: args.delegateKeyRef,
    action: {kind: 'registered_action', config: {action_id: template.action, params: template.params}},
    max_mist_per_run: 0,
  };
}
