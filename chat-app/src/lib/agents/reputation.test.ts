import {describe, expect, it} from 'vitest';

import {
  badgeData,
  confidenceLevel,
  formatCredibility,
  formatReviewCount,
  formatStars,
  overallScore,
  reputationTitle,
  roleScore,
} from './reputation';
import type {AgentReputationInfo, ReputationScoreInfo} from './social-api';

const agg = (w: bigint, s: bigint) => ({weightSumBps: w, weightedStarSum: s});
const EMPTY = agg(0n, 0n);

// These vectors are asserted verbatim in agent_task_tests.move and reputation.rs.
describe('integer Bayesian score (parity with Move and Rust)', () => {
  it('no reviews is the prior with no confidence', () => {
    expect(roleScore(EMPTY)).toEqual({scoreMilli: 3000, confidenceBps: 0});
    expect(overallScore(EMPTY, EMPTY)).toEqual({scoreMilli: 3000, confidenceBps: 0});
  });

  it('one 5★ review at base credibility', () => {
    expect(roleScore(agg(2000n, 10_000_000n))).toEqual({scoreMilli: 3076, confidenceBps: 384});
  });

  it('one 4★ and one 2★ review', () => {
    expect(roleScore(agg(2000n, 8_000_000n)).scoreMilli).toBe(3038);
    expect(roleScore(agg(2000n, 4_000_000n)).scoreMilli).toBe(2961);
  });

  it('a repeat-pair review adds half weight', () => {
    expect(roleScore(agg(3250n, 16_250_000n)).scoreMilli).toBe(3122);
  });

  it('overall blends the roles and sits between the prior and the role score', () => {
    const seller = agg(2000n, 10_000_000n);
    expect(overallScore(seller, EMPTY)).toEqual({scoreMilli: 3039, confidenceBps: 196});
    expect(overallScore(seller, EMPTY).scoreMilli).toBeLessThan(roleScore(seller).scoreMilli);
  });

  it('a buyer-only subject is scaled by the buyer share', () => {
    expect(overallScore(EMPTY, agg(2000n, 8_000_000n)).scoreMilli).toBe(3019);
  });

  it('is exact beyond 2^64', () => {
    const w = 18_446_744_073_709_551_616n;
    expect(roleScore(agg(w, w * 5000n)).scoreMilli).toBe(4999);
  });
});

describe('display helpers', () => {
  it('rounds to one decimal star', () => {
    expect(formatStars(3076)).toBe('3.1');
    expect(formatStars(5000)).toBe('5.0');
  });

  it('pluralizes review counts', () => {
    expect(formatReviewCount(1)).toBe('1 review');
    expect(formatReviewCount(0)).toBe('0 reviews');
    expect(formatReviewCount(1234)).toBe('1,234 reviews');
  });

  it('maps confidence to a level', () => {
    expect(confidenceLevel(0)).toBe('new');
    expect(confidenceLevel(384)).toBe('low');
    expect(confidenceLevel(4000)).toBe('medium');
    expect(confidenceLevel(8000)).toBe('high');
  });

  it('formats credibility as a percentage', () => {
    expect(formatCredibility(2500)).toBe('25%');
    expect(formatCredibility(2550)).toBe('25.5%');
    expect(formatCredibility(10_000)).toBe('100%');
  });

  const role = (count: number, scoreMilli: number): ReputationScoreInfo => ({
    reviewCount: count,
    histogram: [0, 0, 0, 0, count],
    scoreMilli,
    score: scoreMilli / 1000,
    confidenceBps: count ? 384 : 0,
    lastReceiptId: null,
    updatedAtMs: null,
  });
  const reputation: AgentReputationInfo = {
    agentObjectId: '0x1',
    asSeller: role(3, 3076),
    asBuyer: role(0, 3000),
    overall: {scoreMilli: 3039, score: 3.039, confidenceBps: 196},
    credibility: null,
  };

  it('headlines the overall score and totals both roles', () => {
    const data = badgeData(reputation);
    expect(data.totalReviews).toBe(3);
    expect(data.level).toBe('low');
  });

  it('the tooltip names each role so a score is never ambiguous', () => {
    const title = reputationTitle(badgeData(reputation));
    expect(title).toContain('Overall 3.0★');
    expect(title).toContain('As seller: 3.1★ (3 reviews)');
    expect(title).toContain('As buyer: no reviews');
  });
});
