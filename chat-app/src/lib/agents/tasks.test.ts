import {describe, expect, it} from 'vitest';

import {
  TASK_STATUS,
  availableActions,
  bytesToHex,
  computeTermsDigest,
  feeBreakdown,
  formatTermsWindow,
  hexToBytes,
  releaseAtMs,
  taskStatusLabel,
  termsMatchDigest,
  viewerRole,
  type TaskAction,
} from './tasks';
import type {AgentTaskInfo} from './social-api';

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
    expect(acts(delivered(), 'buyer', 2 * DAY)).toEqual(['settle', 'propose_refund']);
    expect(acts(delivered(), 'seller', 2 * DAY)).toEqual(['propose_refund']);
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
    expect(acts(t, 'buyer', DAY)).toEqual(['settle', 'accept_refund', 'reject_refund']);
    expect(acts(t, 'seller', DAY)).toEqual(['propose_refund', 'withdraw_refund']);
    expect(acts(t, 'observer', DAY)).toEqual([]);
  });

  it('the buyer can still settle with a proposal pending, and release is unaffected', () => {
    const t = delivered({refundProposer: 1});
    expect(acts(t, 'buyer', 7 * DAY)).toContain('settle');
    expect(acts(t, 'buyer', 7 * DAY)).toContain('release');
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
