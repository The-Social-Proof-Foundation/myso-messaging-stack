import type {
  AgentReputationInfo,
  OverallScoreInfo,
  ReputationScoreInfo,
} from './social-api';

/**
 * The slice of the task config the score needs. Defaults match `agent_task::bootstrap_init`
 * and are used until a config has been indexed.
 */
export interface ScoringParams {
  priorMeanMilli: number;
  priorWeightBps: number;
  overallSellerWeightBps: number;
  overallBuyerWeightBps: number;
}

export const DEFAULT_SCORING_PARAMS: ScoringParams = {
  priorMeanMilli: 3000,
  priorWeightBps: 50_000,
  overallSellerWeightBps: 5000,
  overallBuyerWeightBps: 5000,
};

/** Running sums for one role: `weightSumBps` is Σw, `weightedStarSum` is Σ w·stars·1000. */
export interface Aggregate {
  weightSumBps: bigint;
  weightedStarSum: bigint;
}

export interface Score {
  scoreMilli: number;
  confidenceBps: number;
}

const BPS = 10_000n;

function finish(num: bigint, den: bigint, evidence: bigint): Score {
  return {
    scoreMilli: Number(num / den),
    confidenceBps: Number((evidence * BPS) / den),
  };
}

/** `(C·m + S) / (C + W)`: the integer-only Bayesian average the contract stores. */
export function roleScore(agg: Aggregate, p: ScoringParams = DEFAULT_SCORING_PARAMS): Score {
  const c = BigInt(p.priorWeightBps);
  return finish(
    c * BigInt(p.priorMeanMilli) + agg.weightedStarSum,
    c + agg.weightSumBps,
    agg.weightSumBps,
  );
}

/** Weighted Bayesian average of both roles; a role without reviews contributes nothing. */
export function overallScore(
  seller: Aggregate,
  buyer: Aggregate,
  p: ScoringParams = DEFAULT_SCORING_PARAMS,
): Score {
  const c = BigInt(p.priorWeightBps);
  const aS = BigInt(p.overallSellerWeightBps);
  const aB = BigInt(p.overallBuyerWeightBps);
  const evidence = aS * seller.weightSumBps + aB * buyer.weightSumBps;
  return finish(
    c * BigInt(p.priorMeanMilli) * BPS + aS * seller.weightedStarSum + aB * buyer.weightedStarSum,
    c * BPS + evidence,
    evidence,
  );
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function formatStars(scoreMilli: number): string {
  return (scoreMilli / 1000).toFixed(1);
}

export function formatReviewCount(count: number): string {
  return count === 1 ? '1 review' : `${count.toLocaleString()} reviews`;
}

export type ConfidenceLevel = 'new' | 'low' | 'medium' | 'high';

/** Plain-language trust in a score: how much of it is evidence rather than the prior. */
export function confidenceLevel(confidenceBps: number): ConfidenceLevel {
  if (confidenceBps <= 0) return 'new';
  if (confidenceBps < 2500) return 'low';
  if (confidenceBps < 6000) return 'medium';
  return 'high';
}

export const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
  new: 'No reviews yet',
  low: 'Early signal',
  medium: 'Building history',
  high: 'Well established',
};

export interface ReputationBadgeData {
  /** Headline: the overall score. */
  overall: OverallScoreInfo;
  asSeller: ReputationScoreInfo;
  asBuyer: ReputationScoreInfo;
  totalReviews: number;
  level: ConfidenceLevel;
}

export function badgeData(reputation: AgentReputationInfo): ReputationBadgeData {
  return {
    overall: reputation.overall,
    asSeller: reputation.asSeller,
    asBuyer: reputation.asBuyer,
    totalReviews: reputation.asSeller.reviewCount + reputation.asBuyer.reviewCount,
    level: confidenceLevel(reputation.overall.confidenceBps),
  };
}

/** Principal credibility as a percentage string (`2500` -> `25%`). */
export function formatCredibility(credibilityBps: number): string {
  return `${(credibilityBps / 100).toFixed(credibilityBps % 100 === 0 ? 0 : 1)}%`;
}

/** Tooltip: both role scores with counts, so the badge never hides which role earned what. */
export function reputationTitle(data: ReputationBadgeData): string {
  const role = (label: string, r: ReputationScoreInfo) =>
    `${label}: ${r.reviewCount === 0 ? 'no reviews' : `${formatStars(r.scoreMilli)}★ (${formatReviewCount(r.reviewCount)})`}`;
  return [
    `Overall ${formatStars(data.overall.scoreMilli)}★ · ${CONFIDENCE_LABEL[data.level]}`,
    role('As seller', data.asSeller),
    role('As buyer', data.asBuyer),
  ].join('\n');
}
