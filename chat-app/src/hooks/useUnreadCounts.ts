/**
 * Sidebar unread badges — delegates to {@link useGroupActivityOrder} for a
 * single batch fetch shared with activity ordering.
 */
import type { StoredGroup } from '../lib/group-store';
import { useGroupActivityOrder } from './useGroupActivityOrder';

export interface UseUnreadCountsResult {
  counts: Record<string, number>;
  markRead: (groupId: string) => void;
  bump: (groupId: string) => void;
  refresh: () => void;
}

export function useUnreadCounts(groups: StoredGroup[]): UseUnreadCountsResult {
  const activity = useGroupActivityOrder(groups);
  return {
    counts: activity.counts,
    markRead: activity.markRead,
    bump: activity.bump,
    refresh: activity.refresh,
  };
}
