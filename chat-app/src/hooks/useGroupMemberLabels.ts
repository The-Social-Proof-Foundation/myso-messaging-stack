import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRequiredMessagingClient } from '../contexts/MessagingClientContext';
import { onGroupMembersInvalidated } from '../lib/group-members-cache';

function truncateAddress(address: string): string {
  if (!address) return 'Someone';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Session cache: groupId -> address -> label */
const labelCache = new Map<string, Map<string, string>>();

export function invalidateGroupMemberLabels(groupId: string): void {
  labelCache.delete(groupId);
}

export interface UseGroupMemberLabelsResult {
  labelFor: (address: string) => string;
  /** Member wallet addresses for the group (excludes system objects). */
  memberAddresses: string[];
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
  const [invalidateEpoch, setInvalidateEpoch] = useState(0);
  const refreshKey = options?.refreshKey ?? 0;
  const groupIdRef = useRef(groupId);
  groupIdRef.current = groupId;

  useEffect(() => {
    return onGroupMembersInvalidated((id) => {
      if (id === groupIdRef.current) {
        invalidateGroupMemberLabels(id);
        setInvalidateEpoch((n) => n + 1);
      }
    });
  }, []);

  useEffect(() => {
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

    const cached = labelCache.get(groupId);
    if (cached && invalidateEpoch === 0) {
      setLabels(cached);
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [client, groupId, refreshKey, invalidateEpoch]);

  const labelFor = useCallback(
    (address: string) => labels.get(address) ?? truncateAddress(address),
    [labels],
  );

  const memberAddresses = useMemo(() => [...labels.keys()], [labels]);

  const refresh = useCallback(() => {
    labelCache.delete(groupId);
    setInvalidateEpoch((n) => n + 1);
  }, [groupId]);

  return { labelFor, memberAddresses, refresh };
}
