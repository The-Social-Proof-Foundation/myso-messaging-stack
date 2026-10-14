import {describe, expect, it} from 'vitest';
import {
  defaultJobName,
  formatJobs,
  pickWorkerDelegate,
  requiredActionsFor,
  ruleSummary,
  ruleToChoice,
  workerDelegateName,
} from './automation-chat';
import {JobFormError, buildTaskJobInput} from './automation-job';
import {isValidDelegateName} from './automation-delegate';

describe('ruleToChoice', () => {
  it('turns MySo amounts into mist for an auto-accept policy', () => {
    expect(ruleToChoice({rule: 'auto_accept', minAmountMyso: '1', maxAmountMyso: '2.5', maxOpenTasks: 3})).toEqual({
      kind: 'auto_accept',
      policy: {minAmountMist: '1000000000', maxAmountMist: '2500000000', maxOpenTasks: '3'},
    });
    expect(ruleToChoice({rule: 'auto_accept'})).toEqual({kind: 'auto_accept', policy: {}});
  });

  it('refuses nonsense amounts and a reversed range', () => {
    expect(() => ruleToChoice({rule: 'auto_accept', minAmountMyso: '0'})).toThrow(JobFormError);
    expect(() => ruleToChoice({rule: 'auto_accept', maxAmountMyso: 'lots'})).toThrow('positive MySo');
    expect(() => ruleToChoice({rule: 'auto_accept', minAmountMyso: '5', maxAmountMyso: '1'})).toThrow('above the maximum');
  });

  it('needs a side and stars for a review, and a duty for a keeper', () => {
    expect(ruleToChoice({rule: 'auto_review', role: 'seller', stars: 5})).toEqual({kind: 'auto_review', role: 'seller', stars: 5});
    expect(() => ruleToChoice({rule: 'auto_review', stars: 5})).toThrow('buyer or seller');
    expect(() => ruleToChoice({rule: 'auto_review', role: 'buyer'})).toThrow('1 to 5');
    expect(ruleToChoice({rule: 'keeper', duty: 'release_to_seller'})).toEqual({kind: 'keeper', duty: 'release_to_seller'});
    expect(() => ruleToChoice({rule: 'keeper'})).toThrow('keeper should do');
  });

  it('produces a job the existing builder accepts', () => {
    const job = buildTaskJobInput({
      name: defaultJobName({rule: 'auto_accept'}, 'Finance Lead'),
      choice: ruleToChoice({rule: 'auto_accept', maxAmountMyso: '5'}),
      targetAgentObjectId: '0xabc',
      delegateKeyRef: 'delegate:worker-abc',
    });
    expect(job.action.kind).toBe('registered_action');
    expect(job.target_agent_key_ref).toBe('delegate:worker-abc');
  });
});

describe('what each rule needs and says', () => {
  it('names the actions the delegate must be allowed to run', () => {
    expect(requiredActionsFor({rule: 'auto_accept'})).toEqual(['task.accept.v1']);
    expect(requiredActionsFor({rule: 'auto_review', role: 'buyer', stars: 4})).toEqual(['task.review.v1']);
    expect(requiredActionsFor({rule: 'keeper', duty: 'expire_offers'})).toEqual(['task.expire_offer.v1']);
  });

  it('describes the rule in a sentence', () => {
    expect(ruleSummary({rule: 'auto_accept', minAmountMyso: '1', maxAmountMyso: '5', maxOpenTasks: 4})).toBe(
      'accept task offers between 1 and 5 MySo, while it has fewer than 4 open tasks',
    );
    expect(ruleSummary({rule: 'auto_accept', maxAmountMyso: '5'})).toContain('up to 5 MySo');
    expect(ruleSummary({rule: 'auto_accept'})).toContain('of any size');
    expect(ruleSummary({rule: 'auto_review', role: 'seller', stars: 5})).toContain('5★');
    expect(ruleSummary({rule: 'keeper', duty: 'refund_missed_delivery'})).toMatch(/^refund/i);
  });
});

describe('delegates', () => {
  it('names a worker the chain accepts, and a retry gets a fresh name', () => {
    const id = '0x' + 'ab'.repeat(32);
    expect(isValidDelegateName(workerDelegateName(id))).toBe(true);
    expect(workerDelegateName(id)).toBe('worker-abababab');
    expect(workerDelegateName(id, 1)).toBe('worker-abababab-2');
    expect(isValidDelegateName(workerDelegateName(id, 3))).toBe(true);
  });

  it('reuses a task worker allowed to run what the rule needs, and nothing else', () => {
    const rows = [
      {delegate_ref: 'delegate:mem', delegate_class: 'memory' as const, allowed_action_ids: []},
      {delegate_ref: 'delegate:review-only', delegate_class: 'task_worker' as const, allowed_action_ids: ['task.review.v1']},
      {delegate_ref: 'delegate:full', delegate_class: 'task_worker' as const, allowed_action_ids: ['task.accept.v1', 'task.review.v1']},
    ];
    expect(pickWorkerDelegate(rows, ['task.accept.v1'])).toBe('delegate:full');
    expect(pickWorkerDelegate(rows, ['task.review.v1'])).toBe('delegate:review-only');
    expect(pickWorkerDelegate(rows, ['task.settle.v1'])).toBeNull();
    expect(pickWorkerDelegate([], ['task.accept.v1'])).toBeNull();
  });
});

describe('formatJobs', () => {
  it('lists jobs and handles none', () => {
    expect(formatJobs([])).toContain('No automations');
    const text = formatJobs([
      {name: 'Auto-accept offers (A)', enabled: true, action: {kind: 'registered_action', config: {action_id: 'task.accept.v1', params: {}}}},
    ]);
    expect(text).toContain('Auto-accept offers (A) — on · accept');
  });
});
