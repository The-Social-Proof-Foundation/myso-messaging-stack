import { useEffect, useMemo, useState } from 'react';
import { useMessagingClient } from '../contexts/MessagingClientContext';

/** Session cache: groupId → member wallet addresses (system objects excluded). */
const membersCache = new Map<string, string[]>();

/**
 * Load member wallets for sidebar groups (cached). Used for conversation avatars.
 */
export function useSidebarGroupMembers(
  groupIds: readonly string[],
): Map<string, string[]> {
  const client = useMessagingClient();
  const [version, setVersion] = useState(0);

  const uniqueKey = useMemo(() => {
    const ids = [...new Set(groupIds.filter(Boolean))].sort();
    return ids.join(',');
  }, [groupIds]);

  useEffect(() => {
    if (!client || !uniqueKey) return;
    const ids = uniqueKey.split(',');
    const missing = ids.filter((id) => !membersCache.has(id));
    if (missing.length === 0) {
      setVersion((v) => v + 1);
      return;
    }

    let cancelled = false;
    const systemAddresses = client.messaging.derive.systemObjectAddresses();

    void (async () => {
      await Promise.all(
        missing.map(async (groupId) => {
          try {
            const { members } = await client.groups.view.getMembers({
              groupId,
              exhaustive: true,
            });
            const addresses = (members as { address: string }[])
              .map((m) => m.address)
              .filter((a) => a && !systemAddresses.has(a));
            membersCache.set(groupId, addresses);
          } catch (err) {
            console.warn(
              `[sidebar] failed to load members for ${groupId.slice(0, 10)}…`,
              err,
            );
            membersCache.set(groupId, []);
          }
        }),
      );
      if (!cancelled) setVersion((v) => v + 1);
    })();

    return () => {
      cancelled = true;
    };
  }, [client, uniqueKey]);

  return useMemo(() => {
    const map = new Map<string, string[]>();
    for (const id of uniqueKey ? uniqueKey.split(',') : []) {
      map.set(id, membersCache.get(id) ?? []);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueKey, version]);
}
