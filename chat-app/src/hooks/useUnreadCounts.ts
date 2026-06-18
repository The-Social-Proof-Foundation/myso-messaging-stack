import { useEffect, useState } from 'react';
import { useRequiredMessagingClient } from '../contexts/MessagingClientContext';
import type { StoredGroup } from '../lib/group-store';

export function useUnreadCounts(groups: StoredGroup[]): Record<string, number> {
  const { client, signer } = useRequiredMessagingClient();
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (groups.length === 0) {
      setCounts({});
      return;
    }

    let cancelled = false;

    async function refresh() {
      try {
        const groupIds = groups.map((g) => g.groupId);
        const next = await client.messaging.getUnreadCounts({
          signer,
          groupIds,
        });
        if (!cancelled) setCounts(next);
      } catch (err) {
        console.warn('Failed to refresh unread counts:', err);
      }
    }

    refresh().then();
    const timer = setInterval(() => {
      refresh().then();
    }, 15_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [groups, client, signer]);

  return counts;
}
