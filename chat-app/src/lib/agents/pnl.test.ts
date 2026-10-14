import {describe, expect, it} from 'vitest';
import {computeAgentPnl, formatSignedMist} from './pnl';
import type {TaskReceiptInfo} from './social-api';

const ME = '0x' + 'a1'.repeat(32);
const OTHER = '0x' + 'b2'.repeat(32);
const receipt = (over: Partial<TaskReceiptInfo>): TaskReceiptInfo =>
  ({
    taskId: Math.random().toString(),
    sellerAgentId: OTHER,
    buyerAgentId: null,
    amountMist: 1_000,
    platformFeeMist: 0,
    ecosystemFeeMist: 0,
    netAmountMist: 0,
    ...over,
  }) as TaskReceiptInfo;

describe('computeAgentPnl', () => {
  it('counts what a seller was paid net of fees', () => {
    const r = computeAgentPnl([receipt({sellerAgentId: ME, amountMist: 1_000, netAmountMist: 940, platformFeeMist: 40, ecosystemFeeMist: 20})], ME, 0n);
    expect(r.revenueMist).toBe(940n);
    expect(r.taskSpendMist).toBe(0n);
    expect(r.pnlMist).toBe(940n);
    expect(r.soldCount).toBe(1);
  });

  it('counts a buyer as paying the seller net plus fees', () => {
    const r = computeAgentPnl([receipt({buyerAgentId: ME, amountMist: 1_000, netAmountMist: 940, platformFeeMist: 40, ecosystemFeeMist: 20})], ME, 0n);
    expect(r.taskSpendMist).toBe(1_000n);
    expect(r.pnlMist).toBe(-1_000n);
    expect(r.boughtCount).toBe(1);
  });

  it('counts only what moved when a dispute split the escrow', () => {
    const r = computeAgentPnl([receipt({buyerAgentId: ME, amountMist: 1_000, netAmountMist: 470, platformFeeMist: 20, ecosystemFeeMist: 10})], ME, 0n);
    expect(r.taskSpendMist).toBe(500n);
  });

  it('subtracts AI spend and combines both sides', () => {
    const r = computeAgentPnl(
      [receipt({sellerAgentId: ME, netAmountMist: 900}), receipt({buyerAgentId: ME, netAmountMist: 300, platformFeeMist: 30, ecosystemFeeMist: 20})],
      ME,
      100n,
    );
    expect(r.revenueMist).toBe(900n);
    expect(r.taskSpendMist).toBe(350n);
    expect(r.pnlMist).toBe(450n);
  });

  it('ignores other agents, tolerates padding and case, and treats missing AI spend as zero', () => {
    const r = computeAgentPnl([receipt({sellerAgentId: OTHER, netAmountMist: 5_000}), receipt({sellerAgentId: ME.toUpperCase().replace('0X', '0x'), netAmountMist: 7})], ME, null);
    expect(r.revenueMist).toBe(7n);
    expect(r.aiSpentMist).toBe(0n);
  });

  it('is zero with no activity', () => {
    expect(computeAgentPnl([], ME, undefined).pnlMist).toBe(0n);
  });
});

describe('formatSignedMist', () => {
  it('signs gains and losses', () => {
    expect(formatSignedMist(0n)).toBe('0');
    expect(formatSignedMist(1_500_000_000n).startsWith('+')).toBe(true);
    expect(formatSignedMist(-1_500_000_000n).startsWith('−')).toBe(true);
  });
});
