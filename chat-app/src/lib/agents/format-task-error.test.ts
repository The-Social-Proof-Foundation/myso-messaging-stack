import {describe, expect, it} from 'vitest';

import {classifyTaskError} from './format-task-error';

const classify = (text: string) => classifyTaskError(new Error(text));

describe('classifyTaskError', () => {
  it.each([
    ['MoveAbort(... agent_task, ETermsMismatch) code 8', 'terms_changed'],
    ['abort in agent_task::EAcceptExpired', 'accept_expired'],
    ['EWrongStatus', 'wrong_status'],
    ['agent_task: ETooEarly', 'too_early'],
    ['EDeliveryDeadlinePassed', 'delivery_late'],
    ['ENotSeller', 'not_seller'],
    ['ENotBuyer', 'not_buyer'],
    ['ENotCounterparty', 'not_counterparty'],
    ['EProposalPending', 'proposal_pending'],
    ['EMarketPaused', 'market_paused'],
    ['EEscrowTooSmall', 'escrow_small'],
    ['ETaskSelfDealing', 'self_dealing'],
    ['EAlreadyReviewed', 'already_reviewed'],
    ['EReviewWindowClosed', 'review_closed'],
    ['EInvalidStars', 'invalid_stars'],
    ['EWrongReviewTarget', 'wrong_review_target'],
    ['memory ESubAgentMissingCap', 'missing_capability'],
    ['memory ESubAgentSpendExceeded', 'spend_cap'],
    ['memory ESubAgentNotActive', 'agent_inactive'],
    ['EIneligible', 'ineligible'],
    [
      "MoveAbort in 1st command, abort code: 9, in '0x50c1::jury::join_roster' (instruction 158)",
      'ineligible',
    ],
  ])('%s -> %s', (text, kind) => {
    expect(classify(text).kind).toBe(kind);
  });

  it('is case-insensitive and explains the missing capability in product terms', () => {
    expect(classify('esubagentmissingcap').message).toContain('Trade tasks');
  });

  it('falls back to the raw message and allows a retry', () => {
    const info = classify('something odd happened');
    expect(info.kind).toBe('unknown');
    expect(info.message).toBe('something odd happened');
    expect(info.retryable).toBe(true);
  });

  it('handles non-Error values', () => {
    expect(classifyTaskError(undefined).kind).toBe('unknown');
    expect(classifyTaskError('ETooEarly').kind).toBe('too_early');
  });
});
