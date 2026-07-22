import { useEffect, useMemo, useState } from 'react';
import { useMessagingClient } from '../contexts/MessagingClientContext';
import { useAuthenticatedAddress } from '../contexts/MySocialAuthContext';
import {
  loadSidebarPeers,
  saveSidebarPeers,
  upsertSidebarPeer,
} from '../lib/sidebar-chrome-store';

/** Session cache: groupId → member wallet addresses (system objects excluded). */
const membersCache = new Map<string, string[]>();
/** groupId → peer wallet from prior visits (breaks avatar waterfall). */
const peerCache = new Map<string, string>();
let hydratedWallet: string | null = null;

function ensureHydrated(wallet: string | null | undefined) {
  const key = wallet?.trim().toLowerCase() || null;
  if (!key || hydratedWallet === key) return;
  peerCache.clear();
  for (const [groupId, peer] of loadSidebarPeers(key)) {
    peerCache.set(groupId, peer);
  }
  hydratedWallet = key;
}

/**
 * Load member wallets for sidebar groups (cached). Used for conversation avatars.
 * Also exposes persisted peer addresses so ProfileFull can start before getMembers.
 */
export function useSidebarGroupMembers(
  groupIds: readonly string[],
): Map<string, string[]> {
  const client = useMessagingClient();
  const address = useAuthenticatedAddress();
  const [version, setVersion] = useState(0);

  const uniqueKey = useMemo(() => {
    const ids = [...new Set(groupIds.filter(Boolean))].sort();
    return ids.join(',');
  }, [groupIds]);

  useEffect(() => {
    ensureHydrated(address);
    setVersion((v) => v + 1);
  }, [address]);

  useEffect(() => {
    if (!client || !uniqueKey) return;
    ensureHydrated(address);
    const ids = uniqueKey.split(',');
    const missing = ids.filter((id) => !membersCache.has(id));
    if (missing.length === 0) {
      setVersion((v) => v + 1);
      return;
    }

    let cancelled = false;
    const systemAddresses = client.messaging.derive.systemObjectAddresses();
    const self = address?.toLowerCase() ?? '';

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
            const peer = addresses.find(
              (a) => a.toLowerCase() !== self,
            );
            if (peer) {
              peerCache.set(groupId, peer.toLowerCase());
              upsertSidebarPeer(address, groupId, peer);
            }
          } catch (err) {
            console.warn(
              `[sidebar] failed to load members for ${groupId.slice(0, 10)}…`,
              err,
            );
            membersCache.set(groupId, []);
          }
        }),
      );
      if (!cancelled) {
        saveSidebarPeers(address, peerCache);
        setVersion((v) => v + 1);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, uniqueKey, address]);

  return useMemo(() => {
    ensureHydrated(address);
    const map = new Map<string, string[]>();
    for (const id of uniqueKey ? uniqueKey.split(',') : []) {
      const live = membersCache.get(id);
      if (live && live.length > 0) {
        map.set(id, live);
        continue;
      }
      // Seed from persisted peer so avatars/titles can resolve before getMembers.
      const peer = peerCache.get(id);
      if (peer) {
        const self = address?.toLowerCase();
        map.set(id, self && self !== peer ? [peer, self] : [peer]);
      } else {
        map.set(id, live ?? []);
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueKey, version, address]);
}
