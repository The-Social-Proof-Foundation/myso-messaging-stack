import { useCallback, useEffect, useRef, useState } from 'react';
import { useRequiredMessagingClient } from '../contexts/MessagingClientContext';

function truncateAddress(address: string): string {
  if (!address) return 'Someone';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Session cache: groupId -> address -> label */
const labelCache = new Map<string, Map<string, string>>();

export interface UseGroupMemberLabelsResult {
  labelFor: (address: string) => string;
  refresh: () => void;
}

/**
 * Resolves member addresses to display labels for the active group.
 * Falls back to truncated addresses when no richer metadata is available.
 */
export function useGroupMemberLabels(
  groupId: string,
  options?: { refreshKey?: number },
): UseGroupMemberLabelsResult {
  const { client } = useRequiredMessagingClient();
  const [labels, setLabels] = useState<Map<string, string>>(
    () => labelCache.get(groupId) ?? new Map(),
  );
  const refreshKey = options?.refreshKey ?? 0;
  const groupIdRef = useRef(groupId);
  groupIdRef.current = groupId;

  useEffect(() => {
    const cached = labelCache.get(groupId);
    if (cached) {
      setLabels(cached);
    } else {
      setLabels(new Map());
    }

    let cancelled = false;

    async function load() {
      try {
        const systemAddresses = client.messaging.derive.systemObjectAddresses();
        const { members } = await client.groups.view.getMembers({
          groupId,
          exhaustive: true,
        });

        if (cancelled || groupIdRef.current !== groupId) return;

        const next = new Map<string, string>();
        for (const raw of members as { address: string }[]) {
          if (systemAddresses.has(raw.address)) continue;
          next.set(raw.address, truncateAddress(raw.address));
        }

        labelCache.set(groupId, next);
        setLabels(next);
      } catch (err) {
        console.warn('Failed to load member labels:', err);
      }
    }

    load().then();

    return () => {
      cancelled = true;
    };
  }, [client, groupId, refreshKey]);

  const labelFor = useCallback(
    (address: string) => labels.get(address) ?? truncateAddress(address),
    [labels],
  );

  const refresh = useCallback(() => {
    labelCache.delete(groupId);
  }, [groupId]);

  return { labelFor, refresh };
}
