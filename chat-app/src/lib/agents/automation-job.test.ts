import {describe, expect, it} from 'vitest';

import {
  JURY_CRANK_LABELS,
  JUROR_AUTOMATION_LABELS,
  JobFormError,
  JURY_CRANK_KINDS,
  OPERATOR_KEY_REF,
  KEEPER_DUTY_LABELS,
  TASK_AUTOMATION_LABELS,
  acceptPolicyToConfig,
  buildJobInput,
  buildJurorJobInput,
  buildCrankJobInput,
  buildTaskJobInput,
  localTimeToUtcCron,
  requiredJurorActions,
  crankAction,
  requiredTaskActions,
  scheduleToTriggerSet,
  type KeeperDuty,
  type TaskAutomationChoice,
} from './automation-job';
import {JUROR_ACTION_IDS, TASK_ACTION_IDS} from './automation-delegate';

const CDT = 300; // getTimezoneOffset() for UTC-5
const IST = -330; // UTC+5:30

describe('localTimeToUtcCron', () => {
  it('converts a local time to UTC', () => {
    expect(localTimeToUtcCron('09:00', null, CDT)).toBe('0 14 * * *');
    expect(localTimeToUtcCron('09:00', null, 0)).toBe('0 9 * * *');
    expect(localTimeToUtcCron('09:00', null, IST)).toBe('30 3 * * *');
  });

  it('moves the weekday when conversion crosses midnight', () => {
    // Monday 22:00 in UTC-5 is Tuesday 03:00 UTC.
    expect(localTimeToUtcCron('22:00', 1, CDT)).toBe('0 3 * * 2');
    // Sunday 01:00 in UTC+5:30 is Saturday 19:30 UTC.
    expect(localTimeToUtcCron('01:00', 0, IST)).toBe('30 19 * * 6');
  });

  it('rejects bad times', () => {
    for (const bad of ['', '9', '24:00', '09:60', 'ab:cd']) {
      expect(() => localTimeToUtcCron(bad, null, 0), bad).toThrow(JobFormError);
    }
  });
});

describe('scheduleToTriggerSet', () => {
  it('builds an interval in milliseconds', () => {
    const set = scheduleToTriggerSet({kind: 'interval', every: 2, unit: 'hours'}, 0);
    expect(set.triggers[0]).toMatchObject({kind: 'interval', interval_ms: 7_200_000});
  });

  it('rejects fractional or empty intervals', () => {
    expect(() => scheduleToTriggerSet({kind: 'interval', every: 0, unit: 'minutes'}, 0)).toThrow(JobFormError);
    expect(() => scheduleToTriggerSet({kind: 'interval', every: 1.5, unit: 'minutes'}, 0)).toThrow(JobFormError);
  });

  it('builds a weekly cron trigger', () => {
    const set = scheduleToTriggerSet({kind: 'weekly', day: 5, time: '08:30'}, 0);
    expect(set.triggers[0]).toMatchObject({kind: 'cron', cron_expr: '30 8 * * 5'});
  });
});

describe('buildJobInput', () => {
  const base = {
    name: ' Morning brief ',
    schedule: {kind: 'daily', time: '09:00'} as const,
    task: {kind: 'recall', query: ' what changed overnight '} as const,
    targetAgentObjectId: '0xagent',
    delegateKeyRef: 'delegate:nightly',
    utcOffsetMinutes: 0,
  };

  it('signs as the delegate and targets the owning agent', () => {
    const job = buildJobInput(base);
    expect(job.name).toBe('Morning brief');
    expect(job.target_agent_object_id).toBe('0xagent');
    expect(job.target_agent_key_ref).toBe('delegate:nightly');
    expect(job.action.config).toMatchObject({operation: 'recall', key_ref: 'delegate:nightly', query: 'what changed overnight'});
  });

  it('refuses incomplete jobs with a readable message', () => {
    expect(() => buildJobInput({...base, name: ' '})).toThrow('name');
    expect(() => buildJobInput({...base, delegateKeyRef: ''})).toThrow('delegate');
    expect(() => buildJobInput({...base, task: {kind: 'recall', query: ' '}})).toThrow('look up');
    expect(() => buildJobInput({...base, task: {kind: 'remember', text: ''}})).toThrow('save');
  });
});

describe('acceptPolicyToConfig', () => {
  it('leaves blank fields out and renames the rest for the engine', () => {
    expect(acceptPolicyToConfig({})).toEqual({});
    expect(
      acceptPolicyToConfig({
        minAmountMist: ' 1000000000 ',
        maxAmountMist: '5000000000',
        minDeliveryWindowMs: '3600000',
        maxOpenTasks: '3',
        minBuyerScoreMilli: '3000',
        minBuyerCredibilityBps: '2000',
        allowedBuyerPrincipals: ['0xAbC', ' '],
        scopeDigestAllowlist: ['AB'.repeat(32)],
      }),
    ).toEqual({
      min_amount_mist: '1000000000',
      max_amount_mist: '5000000000',
      min_delivery_window_ms: '3600000',
      max_open_tasks: '3',
      min_buyer_score_milli: '3000',
      min_buyer_credibility_bps: '2000',
      allowed_buyer_principals: ['0xAbC'],
      scope_digest_allowlist: ['ab'.repeat(32)],
    });
  });

  it('refuses values the contract or engine would reject', () => {
    expect(() => acceptPolicyToConfig({minAmountMist: '1.5'})).toThrow(JobFormError);
    expect(() => acceptPolicyToConfig({minAmountMist: '-1'})).toThrow(JobFormError);
    expect(() => acceptPolicyToConfig({minAmountMist: '10', maxAmountMist: '5'})).toThrow('above the maximum');
    expect(() => acceptPolicyToConfig({minBuyerScoreMilli: '5001'})).toThrow('too large');
    expect(() => acceptPolicyToConfig({minBuyerCredibilityBps: '10001'})).toThrow('too large');
    expect(() => acceptPolicyToConfig({allowedBuyerPrincipals: ['not-an-address']})).toThrow('0x address');
    expect(() => acceptPolicyToConfig({scopeDigestAllowlist: ['abc']})).toThrow('64 hex');
  });
});

describe('buildTaskJobInput', () => {
  const base = {
    name: ' Accept good offers ',
    targetAgentObjectId: '0xagent',
    delegateKeyRef: 'delegate:worker',
  };
  const secret = 'a-long-shared-secret';

  it('auto-accept accepts exactly the terms the event carries, under the owner policy', () => {
    const job = buildTaskJobInput({
      ...base,
      choice: {kind: 'auto_accept', policy: {maxAmountMist: '5000000000', minBuyerScoreMilli: '3000'}},
    });
    expect(job.name).toBe('Accept good offers');
    expect(job.target_agent_key_ref).toBe('delegate:worker');
    expect(job.trigger_set.triggers).toHaveLength(1);
    expect(job.trigger_set.triggers[0]).toMatchObject({kind: 'event', event_family: 'task', event_type: 'offered'});
    expect(job.action).toEqual({
      kind: 'registered_action',
      config: {
        action_id: 'task.accept.v1',
        params: {
          taskId: '{{event.payload.task_id}}',
          sellerAgentId: '{{event.payload.seller_agent_id}}',
          termsDigestHex: '{{event.payload.terms_digest}}',
        },
        policy: {max_amount_mist: '5000000000', min_buyer_score_milli: '3000'},
      },
    });
    expect(job.max_mist_per_run).toBe(0);
  });

  it('auto-accept omits an empty policy', () => {
    const job = buildTaskJobInput({...base, choice: {kind: 'auto_accept', policy: {}}});
    expect(job.action.kind).toBe('registered_action');
    expect('policy' in (job.action.config as object)).toBe(false);
  });

  it('the worker fires for the seller on acceptance and may only deliver', () => {
    const job = buildTaskJobInput({
      ...base,
      choice: {kind: 'task_worker', webhookUrl: ' https://worker.example.com/hook ', webhookSecret: secret},
    });
    expect(job.trigger_set.triggers[0]).toMatchObject({
      event_type: 'accepted',
      payload_filter: {party_role: 'seller'},
    });
    expect(job.action).toEqual({
      kind: 'webhook',
      config: {
        url: 'https://worker.example.com/hook',
        secret,
        allowed_hosts: ['worker.example.com'],
        allowed_action_ids: ['task.deliver.v1'],
      },
    });
  });

  it('the verifier fires on delivery and may only settle or propose a refund', () => {
    const job = buildTaskJobInput({
      ...base,
      choice: {kind: 'buyer_verifier', webhookUrl: 'https://verify.example.com/', webhookSecret: secret},
    });
    expect(job.trigger_set.triggers[0]).toMatchObject({event_type: 'delivered'});
    expect(job.action.kind).toBe('webhook');
    expect((job.action.config as {allowed_action_ids: string[]}).allowed_action_ids).toEqual([
      'task.settle.v1',
      'task.propose_refund.v1',
    ]);
  });

  it('refuses a webhook that is not https or has a weak secret', () => {
    for (const webhookUrl of ['http://worker.example.com/', 'worker.example.com', 'ftp://x.example.com', '']) {
      expect(
        () => buildTaskJobInput({...base, choice: {kind: 'task_worker', webhookUrl, webhookSecret: secret}}),
        webhookUrl,
      ).toThrow('https://');
    }
    expect(() =>
      buildTaskJobInput({
        ...base,
        choice: {kind: 'task_worker', webhookUrl: 'https://worker.example.com/', webhookSecret: 'short'},
      }),
    ).toThrow('secret');
  });

  it('auto-review builds the right call for each side', () => {
    const buyer = buildTaskJobInput({...base, choice: {kind: 'auto_review', role: 'buyer', stars: 5}});
    expect(buyer.trigger_set.triggers[0]).toMatchObject({
      event_type: 'review_open',
      payload_filter: {party_role: 'buyer'},
    });
    expect(buyer.action.config).toMatchObject({
      action_id: 'task.review.v1',
      params: {raterRole: 'buyer', stars: 5, sellerAccountId: '{{event.payload.seller_account_id}}'},
    });

    const seller = buildTaskJobInput({...base, choice: {kind: 'auto_review', role: 'seller', stars: 4}});
    expect(seller.trigger_set.triggers[0]).toMatchObject({payload_filter: {party_role: 'seller'}});
    expect(seller.action.config).toMatchObject({
      params: {raterRole: 'seller', stars: 4, buyerAgentId: '{{event.payload.buyer_agent_id}}'},
    });
    // The seller side never names a seller account: only the buyer side needs one.
    expect('sellerAccountId' in ((seller.action.config as {params: object}).params)).toBe(false);
  });

  it('refuses a rating outside 1 to 5', () => {
    for (const stars of [0, 6, 2.5, Number.NaN]) {
      expect(() => buildTaskJobInput({...base, choice: {kind: 'auto_review', role: 'buyer', stars}}), String(stars)).toThrow(
        'stars',
      );
    }
  });

  it('each keeper duty listens for its own due event and runs its own action', () => {
    const expected: Record<KeeperDuty, [string, string]> = {
      expire_offers: ['expired_offer_due', 'task.expire_offer.v1'],
      refund_missed_delivery: ['refund_due', 'task.refund.v1'],
      release_to_seller: ['release_due', 'task.release.v1'],
    };
    for (const [duty, [eventType, actionId]] of Object.entries(expected) as [KeeperDuty, [string, string]][]) {
      const job = buildTaskJobInput({...base, choice: {kind: 'keeper', duty}});
      expect(job.trigger_set.triggers[0]).toMatchObject({event_type: eventType});
      expect(job.action.config).toMatchObject({action_id: actionId});
    }
    const release = buildTaskJobInput({...base, choice: {kind: 'keeper', duty: 'release_to_seller'}});
    expect((release.action.config as {params: object}).params).toEqual({
      taskId: '{{event.payload.task_id}}',
      buyerAccountId: '{{event.payload.buyer_account_id}}',
      sellerAccountId: '{{event.payload.seller_account_id}}',
    });
  });

  it('needs a name and a delegate', () => {
    const choice: TaskAutomationChoice = {kind: 'keeper', duty: 'expire_offers'};
    expect(() => buildTaskJobInput({...base, name: ' ', choice})).toThrow('name');
    expect(() => buildTaskJobInput({...base, delegateKeyRef: '', choice})).toThrow('delegate');
  });

  it('only ever names task actions a task worker can be registered for', () => {
    const choices: TaskAutomationChoice[] = [
      {kind: 'auto_accept', policy: {}},
      {kind: 'task_worker', webhookUrl: 'https://w.example.com/', webhookSecret: secret},
      {kind: 'buyer_verifier', webhookUrl: 'https://w.example.com/', webhookSecret: secret},
      {kind: 'auto_review', role: 'buyer', stars: 5},
      {kind: 'keeper', duty: 'expire_offers'},
      {kind: 'keeper', duty: 'refund_missed_delivery'},
      {kind: 'keeper', duty: 'release_to_seller'},
    ];
    for (const choice of choices) {
      const required = requiredTaskActions(choice);
      expect(required.length).toBeGreaterThan(0);
      for (const id of required) expect(TASK_ACTION_IDS as readonly string[]).toContain(id);
      // The template's own action ids are exactly what it declares as required.
      const job = buildTaskJobInput({...base, choice});
      const used =
        job.action.kind === 'registered_action'
          ? [job.action.config.action_id]
          : job.action.kind === 'webhook'
            ? job.action.config.allowed_action_ids
            : [];
      expect([...used].sort()).toEqual([...required].sort());
    }
  });

  it('labels every template and keeper duty', () => {
    expect(Object.keys(TASK_AUTOMATION_LABELS).sort()).toEqual(
      ['auto_accept', 'auto_review', 'buyer_verifier', 'keeper', 'task_worker'],
    );
    expect(Object.keys(KEEPER_DUTY_LABELS)).toHaveLength(3);
  });
});

describe('juror automation', () => {
  const secret = 'a-long-enough-secret';
  const base = {name: 'Serve', targetAgentObjectId: '0xagent', delegateKeyRef: 'delegate:juror'};

  it('accepting a seat runs jury.accept on the case and agent the event names', () => {
    const job = buildJurorJobInput({...base, choice: {kind: 'accept_duty'}});
    // Announced once when drafted, then reminded until the seat is taken, so a lost event is not a lost seat.
    expect(job.trigger_set.triggers).toEqual([
      {kind: 'event', event_family: 'jury', event_type: 'duty_drafted'},
      {
        kind: 'event',
        event_family: 'jury',
        event_type: 'duty_poll',
        payload_filter: {duty_kind: 'accept'},
      },
    ]);
    expect(job.action).toEqual({
      kind: 'registered_action',
      config: {
        action_id: 'jury.accept.v1',
        params: {caseId: '{{event.payload.case_id}}', agentId: '{{event.payload.agent_id}}'},
      },
    });
    expect(job.max_mist_per_run).toBe(0);
  });

  it('claiming a fee runs jury.claim_fee when the fee is claimable', () => {
    const job = buildJurorJobInput({...base, choice: {kind: 'claim_fee'}});
    expect(job.trigger_set.triggers[0]).toMatchObject({event_family: 'jury', event_type: 'fee_claimable'});
    expect(job.action.config).toMatchObject({action_id: 'jury.claim_fee.v1'});
  });

  it('a vote is a webhook that may only commit or reveal, never a registered action', () => {
    const job = buildJurorJobInput({
      ...base,
      choice: {kind: 'judge', webhookUrl: 'https://jury.example.com/webhook/engine', webhookSecret: secret},
    });
    expect(job.trigger_set.triggers.map((t) => t.event_type)).toEqual(['voting_started', 'duty_poll']);
    expect(job.trigger_set.triggers.every((t) => t.event_family === 'jury')).toBe(true);
    expect(job.action).toEqual({
      kind: 'webhook',
      config: {
        url: 'https://jury.example.com/webhook/engine',
        secret,
        allowed_hosts: ['jury.example.com'],
        allowed_action_ids: ['jury.commit_vote.v1', 'jury.reveal_vote.v1'],
      },
    });
  });

  it('refuses a runner that is not https or has a weak secret', () => {
    expect(() =>
      buildJurorJobInput({...base, choice: {kind: 'judge', webhookUrl: 'http://x.example.com/', webhookSecret: secret}}),
    ).toThrow('https://');
    expect(() =>
      buildJurorJobInput({...base, choice: {kind: 'judge', webhookUrl: 'https://x.example.com/', webhookSecret: 'short'}}),
    ).toThrow('secret');
  });

  it('every action a template needs is one a juror delegate is registered for', () => {
    for (const choice of [
      {kind: 'accept_duty'},
      {kind: 'claim_fee'},
      {kind: 'judge', webhookUrl: 'https://x.example.com/', webhookSecret: secret},
    ] as const) {
      for (const id of requiredJurorActions(choice)) {
        expect(JUROR_ACTION_IDS as readonly string[], id).toContain(id);
      }
    }
    expect(Object.keys(JUROR_AUTOMATION_LABELS).sort()).toEqual(['accept_duty', 'claim_fee', 'judge']);
  });

  it('needs a name and a delegate', () => {
    expect(() => buildJurorJobInput({...base, name: ' ', choice: {kind: 'accept_duty'}})).toThrow(JobFormError);
    expect(() => buildJurorJobInput({...base, delegateKeyRef: '', choice: {kind: 'accept_duty'}})).toThrow(
      JobFormError,
    );
  });
});

describe('jury crank automation', () => {
  const base = {name: 'Crank', targetAgentObjectId: '0xagent'};

  it('has a template and a label for every crank the scan can emit', () => {
    // These are the event types the social server's crank scan produces.
    expect([...JURY_CRANK_KINDS].sort()).toEqual(
      [
        'apply_ready',
        'case_finalize_due',
        'escalate_due',
        'execute_ready',
        'fees_due',
        'neutral_due',
        'neutral_start_due',
        'proposal_finalize_due',
        'replace_due',
        'round_finalize_due',
        'select_due',
        'roster_refresh_due',
        'evict_due',
        'sweep_due',
        'vote_refund_sweep_due',
      ].sort(),
    );
    expect(Object.keys(JURY_CRANK_LABELS).sort()).toEqual([...JURY_CRANK_KINDS].sort());
  });

  it('every crank runs a jury action on its own event, signed with the operator key', () => {
    for (const crank of JURY_CRANK_KINDS) {
      const job = buildCrankJobInput({...base, crank});
      expect(crankAction(crank), crank).toMatch(/^jury\.[a-z_]+\.v1$/);
      expect(job.target_agent_key_ref).toBe(OPERATOR_KEY_REF);
      expect(job.trigger_set.triggers).toEqual([{kind: 'event', event_family: 'jury', event_type: crank}]);
      expect(job.action.kind).toBe('registered_action');
      expect(job.max_mist_per_run).toBe(0);
    }
  });

  it('task cranks pass the accounts and platform the scan adds to the event', () => {
    const verdict = buildCrankJobInput({...base, crank: 'execute_ready'});
    expect(verdict.action.config).toMatchObject({
      action_id: 'jury.execute_task_verdict.v1',
      params: {
        taskId: '{{event.payload.task_id}}',
        caseId: '{{event.payload.case_id}}',
        buyerAccountId: '{{event.payload.buyer_account_id}}',
        sellerAccountId: '{{event.payload.seller_account_id}}',
        platformObjectId: '{{event.payload.platform_object_id}}',
      },
    });
    const neutral = buildCrankJobInput({...base, crank: 'neutral_due'});
    expect(neutral.action.config).toMatchObject({
      action_id: 'jury.execute_neutral_resolution.v1',
      params: {buyerAccountId: '{{event.payload.buyer_account_id}}'},
    });
  });

  it('roster upkeep names the agent and its own account, and a sweep names its case', () => {
    const refresh = buildCrankJobInput({...base, crank: 'roster_refresh_due'});
    expect(refresh.action.config).toMatchObject({
      action_id: 'jury.refresh_roster_entry.v1',
      params: {accountId: '{{event.payload.memory_account_id}}', agentId: '{{event.payload.agent_id}}'},
    });
    expect(buildCrankJobInput({...base, crank: 'evict_due'}).action.config).toMatchObject({
      action_id: 'jury.evict_ineligible.v1',
      params: {agentId: '{{event.payload.agent_id}}'},
    });
    expect(buildCrankJobInput({...base, crank: 'sweep_due'}).action.config).toMatchObject({
      action_id: 'jury.sweep_case.v1',
      params: {caseId: '{{event.payload.case_id}}'},
    });
  });

  it('proposal cranks name the registry, proposal and step, and a decision names its case', () => {
    const escalate = buildCrankJobInput({...base, crank: 'escalate_due'});
    expect(escalate.action.config).toMatchObject({
      action_id: 'jury.escalate_proposal.v1',
      params: {
        registryId: '{{event.payload.registry_id}}',
        proposalId: '{{event.payload.proposal_id}}',
        stage: '{{event.payload.stage}}',
      },
    });
    const apply = buildCrankJobInput({...base, crank: 'apply_ready'});
    expect(apply.action.config).toMatchObject({
      action_id: 'jury.apply_proposal_decision.v1',
      params: {caseId: '{{event.payload.case_id}}', proposalId: '{{event.payload.proposal_id}}'},
    });
  });

  it('a vote refund sweep names its registry and proposal', () => {
    expect(buildCrankJobInput({...base, crank: 'vote_refund_sweep_due'}).action.config).toMatchObject({
      action_id: 'jury.sweep_vote_refunds.v1',
      params: {registryId: '{{event.payload.registry_id}}', proposalId: '{{event.payload.proposal_id}}'},
    });
  });

  it('a crank trigger carries no payload filter, so it matches every event for its account', () => {
    for (const crank of JURY_CRANK_KINDS) {
      expect('payload_filter' in buildCrankJobInput({...base, crank}).trigger_set.triggers[0]!).toBe(false);
    }
  });
});
