/**
 * Sidebar activity ordering + unread badges — one batch fetch per refresh cycle.
 *
 * Primary updates come from the user feed (wired in AuthenticatedApp):
 * - `group.activity` -> `recordActivity(groupId, latestOrder)` + `bump`
 * - reading a thread -> `markRead(groupId)`
 * - `read_state.updated` -> `refresh()`
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMessagingClient } from '../contexts/MessagingClientContext';
import { useMySocialAuth } from '../contexts/MySocialAuthContext';
import type { StoredGroup } from '../lib/group-store';
import { updateStoredGroupActivityOrder } from '../lib/group-store';

const RECONCILE_INTERVAL_MS = 60_000;
const REFRESH_DEBOUNCE_MS = 1_500;

export interface UseGroupActivityOrderResult {
  counts: Record<string, number>;
  latestOrders: Record<string, number>;
  markRead: (groupId: string) => void;
  bump: (groupId: string) => void;
  refresh: () => void;
  /** Live or local activity — bumps sidebar sort key. */
  recordActivity: (groupId: string, latestOrder: number) => void;
}

export function useGroupActivityOrder(
  groups: StoredGroup[],
): UseGroupActivityOrderResult {
  const client = useMessagingClient();
  const { keypair: signer } = useMySocialAuth();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [latestOrders, setLatestOrders] = useState<Record<string, number>>(() => {
    const seed: Record<string, number> = {};
    for (const g of groups) {
      if (g.lastActivityOrder !== undefined) {
        seed[g.groupId] = g.lastActivityOrder;
      }
    }
    return seed;
  });

  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const inFlightRef = useRef(false);
  const cancelledRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recordActivity = useCallback((groupId: string, latestOrder: number) => {
    if (!Number.isFinite(latestOrder) || latestOrder <= 0) return;
    setLatestOrders((prev) => {
      const nextOrder = Math.max(prev[groupId] ?? 0, latestOrder);
      if (nextOrder === prev[groupId]) return prev;
      updateStoredGroupActivityOrder(groupId, nextOrder);
      return { ...prev, [groupId]: nextOrder };
    });
  }, []);

  const doRefresh = useCallback(async () => {
    const currentGroups = groupsRef.current;
    if (!client || !signer || currentGroups.length === 0) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    try {
      const groupIds = currentGroups.map((g) => g.groupId);
      const summary = await client.messaging.getGroupActivitySummary({
        signer,
        groupIds,
      });
      if (cancelledRef.current) return;

      setCounts(summary.counts);
      setLatestOrders((prev) => {
        const next = { ...prev };
        for (const [groupId, order] of Object.entries(summary.latestOrders)) {
          next[groupId] = Math.max(prev[groupId] ?? 0, order);
          if (order > 0) {
            updateStoredGroupActivityOrder(groupId, next[groupId]!);
          }
        }
        return next;
      });
    } catch (err) {
      console.warn('Failed to refresh group activity summary:', err);
    } finally {
      inFlightRef.current = false;
    }
  }, [client, signer]);

  const refresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doRefresh().then();
    }, REFRESH_DEBOUNCE_MS);
  }, [doRefresh]);

  const markRead = useCallback((groupId: string) => {
    setCounts((prev) => (prev[groupId] ? { ...prev, [groupId]: 0 } : prev));
  }, []);

  const bump = useCallback(
    (groupId: string) => {
      setCounts((prev) => ({ ...prev, [groupId]: (prev[groupId] ?? 0) + 1 }));
      refresh();
    },
    [refresh],
  );

  useEffect(() => {
    cancelledRef.current = false;

    if (!client || !signer || groups.length === 0) {
      setCounts({});
      return;
    }

    setCounts((prev) => {
      const valid = new Set(groups.map((g) => g.groupId));
      const next: Record<string, number> = {};
      for (const [groupId, count] of Object.entries(prev)) {
        if (valid.has(groupId)) next[groupId] = count;
      }
      return next;
    });

    setLatestOrders((prev) => {
      const valid = new Set(groups.map((g) => g.groupId));
      const next: Record<string, number> = {};
      for (const [groupId, order] of Object.entries(prev)) {
        if (valid.has(groupId)) next[groupId] = order;
      }
      for (const g of groups) {
        if (g.lastActivityOrder !== undefined) {
          next[g.groupId] = Math.max(next[g.groupId] ?? 0, g.lastActivityOrder);
        }
      }
      return next;
    });

    doRefresh().then();
    const timer = setInterval(() => {
      doRefresh().then();
    }, RECONCILE_INTERVAL_MS);

    return () => {
      cancelledRef.current = true;
      clearInterval(timer);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [groups, client, signer, doRefresh]);

  return {
    counts,
    latestOrders,
    markRead,
    bump,
    refresh,
    recordActivity,
  };
}
