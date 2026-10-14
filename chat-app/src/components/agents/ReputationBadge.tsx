import {Star} from 'lucide-react';

import {useAgentReputation} from '../../hooks/agents';
import {
  CONFIDENCE_LABEL,
  badgeData,
  formatCredibility,
  formatReviewCount,
  formatStars,
  reputationTitle,
} from '../../lib/agents/reputation';
import type {AgentReputationInfo} from '../../lib/agents/social-api';

interface ReputationBadgeProps {
  /** The agent to show. Pass `reputation` instead when it is already loaded. */
  agentObjectId?: string | null;
  reputation?: AgentReputationInfo | null;
  /** `detailed` adds the role breakdown and credibility under the headline. */
  variant?: 'compact' | 'detailed';
  className?: string;
}

/**
 * Overall score with review count. The tooltip and the detailed variant always name the role
 * (seller or buyer) behind each score, and the principal's credibility sits beside them, so a
 * high score on little evidence is never read as a track record.
 */
export function ReputationBadge({
  agentObjectId,
  reputation,
  variant = 'compact',
  className = '',
}: Readonly<ReputationBadgeProps>) {
  const query = useAgentReputation(reputation ? null : agentObjectId);
  const data = reputation ?? query.data;
  if (!data) return null;

  const view = badgeData(data);
  const unrated = view.totalReviews === 0;

  return (
    <span className={`inline-flex flex-col ${className}`} title={reputationTitle(view)}>
      <span className="inline-flex items-center gap-1 text-xs text-secondary-700 dark:text-secondary-200">
        <Star
          className={`h-3.5 w-3.5 ${
            unrated ? 'text-secondary-300 dark:text-secondary-600' : 'fill-amber-400 text-amber-400'
          }`}
          aria-hidden
        />
        {unrated ? null : (
          <span className="font-medium tabular-nums">{formatStars(view.overall.scoreMilli)}</span>
        )}
        <span className="text-secondary-400 dark:text-secondary-500">
          {unrated ? 'no reviews yet' : formatReviewCount(view.totalReviews)}
        </span>
      </span>
      {variant === 'detailed' ? (
        <span className="mt-0.5 space-y-0.5 text-[11px] text-secondary-500 dark:text-secondary-400">
          <span className="block">
            As seller:{' '}
            {view.asSeller.reviewCount
              ? `${formatStars(view.asSeller.scoreMilli)}★ (${formatReviewCount(view.asSeller.reviewCount)})`
              : 'no reviews'}
          </span>
          <span className="block">
            As buyer:{' '}
            {view.asBuyer.reviewCount
              ? `${formatStars(view.asBuyer.scoreMilli)}★ (${formatReviewCount(view.asBuyer.reviewCount)})`
              : 'no reviews'}
          </span>
          <span className="block">
            {CONFIDENCE_LABEL[view.level]}
            {data.credibility ? ` · credibility ${formatCredibility(data.credibility.credibilityBps)}` : ''}
          </span>
        </span>
      ) : null}
    </span>
  );
}
