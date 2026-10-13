import {describe, expect, it} from 'vitest';

import {
  JURY_CASE_STATE,
  TASK_STATUS,
  availableActions,
  bytesToHex,
  computeTermsDigest,
  feeBreakdown,
  formatTermsWindow,
  disputeFeeMist,
  hexToBytes,
  releaseAtMs,
  taskStatusLabel,
  termsMatchDigest,
  viewerRole,
  type TaskAction,
} from './tasks';
import type {AgentTaskInfo, JuryCaseDetailInfo, TaskDisputeDetailInfo} from './social-api';

const BUYER = '0xb1';
const SELLER = '0x5e';
const BUYER_AGENT = '0xb1a';
const SELLER_AGENT = '0x5ea';
const CONFIG = {releaseGraceMs: 3 * 86_400_000};
const DAY = 86_400_000;

function task(overrides: Partial<AgentTaskInfo> = {}): AgentTaskInfo {
  return {
    taskId: '0xc1',
    buyerPrincipal: BUYER,
    buyerAgentId: null,
    buyerMemoryAccountId: '0xc2',
    sellerPrincipal: SELLER,
    sellerAgentId: SELLER_AGENT,
    sellerMemoryAccountId: '0xc3',
    organizationId: null,
    roomGroupId: null,
    platformId: null,
    title: 'write the report',
    scopeDigest: '11'.repeat(32),
    amountMist: 1_000_000_000,
    acceptWindowMs: DAY,
    deliveryWindowMs: DAY,
    settleWindowMs: DAY,
    platformFeeBps: 200,
    ecosystemFeeBps: 50,
    termsDigest: '00'.repeat(32),
    status: TASK_STATUS.OFFERED,
    closeKind: null,
    settlementKind: null,
    refundKind: null,
    createdAtMs: 0,
    acceptDeadlineMs: DAY,
    acceptedAtMs: null,
    deliveryDeadlineMs: null,
    deliveredAtMs: null,
    settleDeadlineMs: null,
    settledAtMs: null,
    refundedAtMs: null,
    cancelledAtMs: null,
    reviewDeadlineMs: null,
    deliverableDigest: null,
    deliverableUri: null,
    platformFeeMist: null,
    ecosystemFeeMist: null,
    netAmountMist: null,
    refundProposer: 0,
    refundProposedAtMs: null,
    buyerCredibilityBps: null,
    sellerCredibilityBps: null,
    buyerReviewStars: null,
    sellerReviewStars: null,
    transactionId: 'tx',
    ...overrides,
  };
}

const acts = (t: AgentTaskInfo, role: 'buyer' | 'seller' | 'observer', now: number): TaskAction[] =>
  availableActions(t, role, now, CONFIG);

describe('viewer role', () => {
  it('recognises a principal and its agents', () => {
    const t = task({buyerAgentId: BUYER_AGENT});
    expect(viewerRole(t, {principal: BUYER, agentIds: []})).toBe('buyer');
    expect(viewerRole(t, {principal: SELLER, agentIds: []})).toBe('seller');
    expect(viewerRole(t, {principal: '0xfeed', agentIds: [BUYER_AGENT]})).toBe('buyer');
    expect(viewerRole(t, {principal: '0xfeed', agentIds: [SELLER_AGENT]})).toBe('seller');
    expect(viewerRole(t, {principal: '0xfeed', agentIds: []})).toBe('observer');
  });

  it('compares addresses regardless of zero padding', () => {
    expect(viewerRole(task(), {principal: `0x${'0'.repeat(62)}b1`, agentIds: []})).toBe('buyer');
  });
});

describe('offered', () => {
  it('lets the seller accept or decline and the buyer cancel, until the deadline', () => {
    expect(acts(task(), 'seller', 1000)).toEqual(['accept', 'decline']);
    expect(acts(task(), 'buyer', 1000)).toEqual(['cancel_offer']);
    expect(acts(task(), 'observer', 1000)).toEqual([]);
  });

  it('after the deadline anyone may expire it and the seller can no longer accept', () => {
    expect(acts(task(), 'observer', DAY + 1)).toEqual(['expire_offer']);
    expect(acts(task(), 'seller', DAY + 1)).toEqual(['expire_offer', 'decline']);
    expect(acts(task(), 'seller', DAY + 1)).not.toContain('accept');
  });
});

describe('accepted', () => {
  const accepted = task({status: TASK_STATUS.ACCEPTED, deliveryDeadlineMs: 2 * DAY});

  it('lets only the seller deliver, before the deadline', () => {
    expect(acts(accepted, 'seller', DAY)).toEqual(['deliver']);
    expect(acts(accepted, 'buyer', DAY)).toEqual([]);
  });

  it('after a missed delivery anyone may refund and delivery is closed', () => {
    expect(acts(accepted, 'observer', 2 * DAY + 1)).toEqual(['refund_missed_delivery']);
    expect(acts(accepted, 'seller', 2 * DAY + 1)).not.toContain('deliver');
  });
});

describe('delivered', () => {
  const delivered = (over: Partial<AgentTaskInfo> = {}) =>
    task({status: TASK_STATUS.DELIVERED, settleDeadlineMs: 3 * DAY, ...over});

  it('offers the buyer settle and both parties a refund proposal, never a unilateral refund', () => {
    expect(acts(delivered(), 'buyer', 2 * DAY)).toEqual(['settle', 'propose_refund', 'open_dispute']);
    expect(acts(delivered(), 'seller', 2 * DAY)).toEqual(['propose_refund', 'open_dispute']);
    for (const role of ['buyer', 'seller', 'observer'] as const) {
      expect(acts(delivered(), role, 100 * DAY)).not.toContain('refund_missed_delivery');
    }
  });

  it('release opens only after the settle deadline plus the grace period', () => {
    const t = delivered();
    expect(releaseAtMs(t, CONFIG)).toBe(6 * DAY);
    expect(acts(t, 'observer', 6 * DAY)).toEqual([]);
    expect(acts(t, 'observer', 6 * DAY + 1)).toEqual(['release']);
  });

  it('a pending proposal gives the counterparty accept and reject and the proposer withdraw', () => {
    const t = delivered({refundProposer: 2});
    expect(acts(t, 'buyer', DAY)).toEqual([
      'settle',
      'accept_refund',
      'reject_refund',
      'open_dispute',
    ]);
    expect(acts(t, 'seller', DAY)).toEqual(['propose_refund', 'withdraw_refund', 'open_dispute']);
    expect(acts(t, 'observer', DAY)).toEqual([]);
  });

  it('the buyer can still settle with a proposal pending, and release is unaffected', () => {
    const t = delivered({refundProposer: 1});
    expect(acts(t, 'buyer', 7 * DAY)).toContain('settle');
    expect(acts(t, 'buyer', 7 * DAY)).toContain('release');
  });
});

describe('disputes', () => {
  const delivered = (over: Partial<AgentTaskInfo> = {}) =>
    task({status: TASK_STATUS.DELIVERED, settleDeadlineMs: 3 * DAY, ...over});
  const disputed = task({status: TASK_STATUS.DISPUTED, settleDeadlineMs: 3 * DAY});

  function dispute(over: Partial<TaskDisputeDetailInfo> = {}, jury: Partial<JuryCaseDetailInfo> | null = {}) {
    const base: TaskDisputeDetailInfo = {
      taskId: '0xc1',
      caseId: '0xca5e',
      openedByRole: 1,
      state: 1,
      feeEachMist: 30_000_000,
      buyerPaidMist: 30_000_000,
      sellerPaidMist: 0,
      openedAtMs: 0,
      neutralWindowEndsMs: null,
      agreementProposer: 0,
      agreementOutcome: null,
      resolvedOutcome: null,
      resolvedSource: null,
      resolvedAtMs: null,
      feesSettled: false,
      buyerFeeRefundMist: null,
      sellerFeeRefundMist: null,
      case:
        jury === null
          ? null
          : {
              caseId: '0xca5e',
              subjectKind: 1,
              subjectId: '0xc1',
              menuLen: 3,
              roundSizes: [3, 5],
              appealable: true,
              feeMist: 30_000_000,
              evidenceDeadlineMs: 2 * DAY,
              state: JURY_CASE_STATE.EVIDENCE,
              currentRound: 0,
              finalOutcome: null,
              appealsUsed: 0,
              failedAppeal: false,
              participants: null,
              perJurorFeeMist: null,
              failReason: null,
              rounds: [],
              jurors: [],
              evidence: [],
              ...jury,
            },
      ...over,
    };
    return base;
  }
  const dact = (role: 'buyer' | 'seller' | 'observer', d: TaskDisputeDetailInfo | null, now = DAY) =>
    availableActions(disputed, role, now, CONFIG, d);

  it('lets a party take delivered work to a jury only until the seller could be paid automatically', () => {
    expect(acts(delivered(), 'buyer', 6 * DAY)).toContain('open_dispute');
    expect(acts(delivered(), 'buyer', 6 * DAY + 1)).not.toContain('open_dispute');
    expect(acts(delivered(), 'observer', DAY)).not.toContain('open_dispute');
  });

  it('freezes everything else while disputed', () => {
    const none = dact('buyer', null);
    expect(none).toEqual([]);
    for (const a of ['settle', 'release', 'propose_refund'] as const) {
      expect(dact('buyer', dispute())).not.toContain(a);
    }
  });

  it('before the draw the other side may match the fee and either may add evidence', () => {
    expect(dact('seller', dispute())).toEqual(['respond_dispute', 'dispute_evidence', 'propose_settlement']);
    expect(dact('buyer', dispute())).toEqual(['dispute_evidence', 'cancel_dispute', 'propose_settlement']);
    expect(dact('observer', dispute())).toEqual([]);
  });

  it('does not offer to match a fee already matched', () => {
    expect(dact('seller', dispute({sellerPaidMist: 30_000_000}))).toEqual(['dispute_evidence', 'propose_settlement']);
  });

  it('after the draw only the loser may appeal, and only while the window is open', () => {
    const tallied = (leading: number, appealDeadlineMs: number | null) =>
      dispute(
        {},
        {
          state: JURY_CASE_STATE.TALLIED,
          rounds: [
            {
              round: 0,
              acceptDeadlineMs: 0,
              commitDeadlineMs: 0,
              revealDeadlineMs: 0,
              tally: [2, 1, 0],
              abstain: 0,
              revealed: 3,
              decisive: true,
              leading,
              appealDeadlineMs,
            },
          ],
        },
      );
    expect(dact('buyer', tallied(0, 2 * DAY))).toContain('appeal');
    expect(dact('seller', tallied(0, 2 * DAY))).not.toContain('appeal');
    expect(dact('seller', tallied(1, 2 * DAY))).toContain('appeal');
    expect(dact('buyer', tallied(2, 2 * DAY))).toContain('appeal');
    expect(dact('buyer', tallied(0, 2 * DAY), 3 * DAY)).not.toContain('appeal');
  });

  it('anyone may apply a final verdict', () => {
    const final = dispute({}, {state: JURY_CASE_STATE.FINAL, finalOutcome: 1});
    expect(dact('observer', final)).toEqual(['execute_verdict']);
    expect(dact('buyer', final)).toEqual(['execute_verdict']);
  });

  it('a failed jury opens the settlement window, then anyone may run the 50/50 split', () => {
    const failed = dispute({}, {state: JURY_CASE_STATE.FAILED});
    expect(dact('observer', failed)).toEqual(['start_neutral']);
    const open = dispute({neutralWindowEndsMs: 2 * DAY}, {state: JURY_CASE_STATE.FAILED});
    expect(dact('observer', open, DAY)).toEqual([]);
    expect(dact('observer', open, 2 * DAY + 1)).toEqual(['execute_neutral']);
    expect(dact('buyer', open, DAY)).toEqual(['propose_settlement']);
  });

  it('a pending agreement is accepted or cleared by the other side and cleared by its proposer', () => {
    const pending = dispute({agreementProposer: 1, agreementOutcome: 2});
    expect(dact('seller', pending)).toContain('accept_settlement');
    expect(dact('seller', pending)).toContain('clear_settlement');
    expect(dact('buyer', pending)).toContain('clear_settlement');
    expect(dact('buyer', pending)).not.toContain('accept_settlement');
  });

  it('pays out the fee pool once, after the dispute is over', () => {
    const over = dispute({state: 3}, {state: JURY_CASE_STATE.FINAL});
    const settled = task({status: TASK_STATUS.SETTLED, reviewDeadlineMs: 10 * DAY});
    expect(availableActions(settled, 'observer', DAY, CONFIG, over)).toEqual(['settle_fees']);
    expect(availableActions(settled, 'observer', DAY, CONFIG, {...over, feesSettled: true})).toEqual([]);
    const withdrawn = dispute({state: 2}, {state: JURY_CASE_STATE.CANCELLED});
    expect(availableActions(delivered(), 'observer', DAY, CONFIG, withdrawn)).toEqual(['settle_fees']);
  });

  it('prices the case fee like the contract', () => {
    expect(disputeFeeMist(1_000_000_000)).toBe(100_000_000);
    expect(disputeFeeMist(10_000_000_000)).toBe(300_000_000);
    expect(disputeFeeMist(10_000_000_000_000)).toBe(50_000_000_000);
  });

  it('labels the frozen state and the new ways a task can end', () => {
    expect(taskStatusLabel(disputed)).toBe('In dispute');
    expect(taskStatusLabel(task({status: TASK_STATUS.SETTLED, settlementKind: 7}))).toBe(
      'Split after the jury could not decide',
    );
    expect(taskStatusLabel(task({status: TASK_STATUS.REFUNDED, refundKind: 2}))).toBe('Refunded by jury verdict');
  });
});

describe('settled', () => {
  const settled = (over: Partial<AgentTaskInfo> = {}) =>
    task({status: TASK_STATUS.SETTLED, reviewDeadlineMs: 10 * DAY, ...over});

  it('offers each party one review until the window closes', () => {
    expect(acts(settled(), 'buyer', DAY)).toEqual(['review']);
    expect(acts(settled(), 'seller', DAY)).toEqual(['review']);
    expect(acts(settled(), 'observer', DAY)).toEqual([]);
    expect(acts(settled(), 'buyer', 10 * DAY + 1)).toEqual([]);
  });

  it('hides the review action for a direction already reviewed, independently', () => {
    const t = settled({buyerReviewStars: 5});
    expect(acts(t, 'buyer', DAY)).toEqual([]);
    expect(acts(t, 'seller', DAY)).toEqual(['review']);
  });
});

describe('closed tasks', () => {
  it.each([TASK_STATUS.REFUNDED, TASK_STATUS.CANCELLED])('status %i has no actions', (status) => {
    for (const role of ['buyer', 'seller', 'observer'] as const) {
      expect(acts(task({status}), role, DAY)).toEqual([]);
    }
  });
});

describe('labels', () => {
  it('distinguishes how a task ended', () => {
    expect(taskStatusLabel(task({status: TASK_STATUS.CANCELLED, closeKind: 1}))).toBe('Declined by seller');
    expect(taskStatusLabel(task({status: TASK_STATUS.SETTLED, settlementKind: 2}))).toBe('Released to seller');
    expect(taskStatusLabel(task({status: TASK_STATUS.REFUNDED, refundKind: 1}))).toBe('Refunded by agreement');
    expect(taskStatusLabel(task({status: TASK_STATUS.ACCEPTED}))).toBe('In progress');
  });
});

describe('fee breakdown', () => {
  it('folds the platform share into the ecosystem fee without a platform', () => {
    expect(feeBreakdown(1_000_000_000, 200, 50, false)).toEqual({
      platformFeeMist: 0,
      ecosystemFeeMist: 25_000_000,
      netMist: 975_000_000,
    });
  });

  it('splits them with a platform', () => {
    expect(feeBreakdown(1_000_000_000, 200, 50, true)).toEqual({
      platformFeeMist: 20_000_000,
      ecosystemFeeMist: 5_000_000,
      netMist: 975_000_000,
    });
  });

  it('floors each share like the contract', () => {
    expect(feeBreakdown(999, 200, 50, true)).toEqual({platformFeeMist: 19, ecosystemFeeMist: 4, netMist: 976});
  });
});

describe('terms digest', () => {
  const input = {
    buyerPrincipal: BUYER,
    sellerAgentId: SELLER_AGENT,
    amountMist: 1_000_000_000n,
    scopeDigest: new Uint8Array(32).fill(0x11),
    acceptWindowMs: DAY,
    deliveryWindowMs: DAY,
    settleWindowMs: DAY,
    platformFeeBps: 200,
    ecosystemFeeBps: 50,
    ecosystemFeeRecipient: '0xad',
    platformId: null,
  };

  it('is a deterministic 32-byte sha3-256', () => {
    const a = computeTermsDigest(input);
    expect(a).toHaveLength(32);
    expect(bytesToHex(computeTermsDigest(input))).toBe(bytesToHex(a));
  });

  it('changes when any approved term changes', () => {
    const base = bytesToHex(computeTermsDigest(input));
    const variants = [
      {amountMist: 1_000_000_001n},
      {acceptWindowMs: DAY + 1},
      {deliveryWindowMs: DAY + 1},
      {settleWindowMs: DAY + 1},
      {platformFeeBps: 201},
      {ecosystemFeeBps: 51},
      {ecosystemFeeRecipient: '0xae'},
      {platformId: '0x7'},
      {scopeDigest: new Uint8Array(32).fill(0x12)},
      {sellerAgentId: '0x5eb'},
      {buyerPrincipal: '0xb2'},
    ];
    for (const change of variants) {
      expect(bytesToHex(computeTermsDigest({...input, ...change}))).not.toBe(base);
    }
  });

  it('termsMatchDigest accepts the right hash and rejects a tampered display', () => {
    const digest = bytesToHex(computeTermsDigest(input));
    const t = task({termsDigest: digest});
    expect(termsMatchDigest(t, {ecosystemFeeRecipient: '0xad'})).toBe(true);
    expect(termsMatchDigest({...t, amountMist: 2_000_000_000}, {ecosystemFeeRecipient: '0xad'})).toBe(false);
    expect(termsMatchDigest({...t, scopeDigest: 'zz'}, {ecosystemFeeRecipient: '0xad'})).toBe(false);
  });

  it('round-trips hex', () => {
    expect(bytesToHex(hexToBytes('0x0aff'))).toBe('0aff');
    expect(() => hexToBytes('abc')).toThrow();
  });
});

describe('formatTermsWindow', () => {
  it('prefers whole days, then hours, then minutes', () => {
    expect(formatTermsWindow(DAY)).toBe('1 day');
    expect(formatTermsWindow(3 * DAY)).toBe('3 days');
    expect(formatTermsWindow(36 * 3_600_000)).toBe('36 hours');
    expect(formatTermsWindow(90 * 60_000)).toBe('1.5 hours');
    expect(formatTermsWindow(300_000)).toBe('5 min');
  });
});
