import { useEffect, useState } from 'react';
import { useMessagingClient } from '../contexts/MessagingClientContext';
import { useMySocialAuth } from '../contexts/MySocialAuthContext';
import type { StoredGroup } from '../lib/group-store';

export function useUnreadCounts(groups: StoredGroup[]): Record<string, number> {
  const client = useMessagingClient();
  const { keypair: signer } = useMySocialAuth();
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!client || !signer || groups.length === 0) {
      setCounts({});
      return;
    }

    const messagingClient = client;
    const messagingSigner = signer;
    let cancelled = false;

    async function refresh() {
      try {
        const groupIds = groups.map((g) => g.groupId);
        const next = await messagingClient.messaging.getUnreadCounts({
          signer: messagingSigner,
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
