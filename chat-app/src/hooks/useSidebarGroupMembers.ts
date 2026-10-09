import { useEffect, useMemo, useRef, useState } from 'react';
import { useMessagingClient, useMessagingMemberAddress } from '../contexts/MessagingClientContext';
import { useAuthenticatedAddress } from '../contexts/MySocialAuthContext';
import { onGroupMembersInvalidated } from '../lib/group-members-cache';
import { pickDmPeer, selfIdentityKeys } from '../lib/self-identity';
import { zkLoginChainAddress } from '../lib/zklogin-signin';
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

export function invalidateSidebarGroupMembers(groupId: string): void {
  membersCache.delete(groupId);
}

function ensureHydrated(wallet: string | null | undefined) {
  const key = wallet?.trim().toLowerCase() || null;
  if (!key || hydratedWallet === key) return;
  // Membership and peers are both per-wallet: a re-login or account switch must not
  // inherit the previous identity's roster, or the row renders the wrong faces.
  membersCache.clear();
  peerCache.clear();
  for (const [groupId, peer] of loadSidebarPeers(key)) {
    peerCache.set(groupId, peer);
  }
  hydratedWallet = key;
}

/**
 * Every address this viewer can appear as on-chain.
 *
 * `messagingAddress` is null until the signing keypair finishes deriving, so identity is
 * always taken as the union of the messaging key, the authenticated address and the
 * stored zkLogin principal rather than whichever one happens to be available first.
 */
function viewerIdentityKeys(
  messagingAddress: string | undefined,
  authenticatedAddress: string | undefined,
): Set<string> {
  return selfIdentityKeys([
    messagingAddress,
    authenticatedAddress,
    zkLoginChainAddress(),
  ]);
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
  const messagingAddress = useMessagingMemberAddress();
  const [version, setVersion] = useState(0);

  // Both of the viewer's wallets: the messaging key (null until the keypair derives)
  // and the zkLogin principal (already known from the stored session).
  const selfKeys = useMemo(
    () => viewerIdentityKeys(messagingAddress, address),
    [messagingAddress, address],
  );
  const selfKeysRef = useRef(selfKeys);
  selfKeysRef.current = selfKeys;

  const uniqueKey = useMemo(() => {
    const ids = [...new Set(groupIds.filter(Boolean))].sort();
    return ids.join(',');
  }, [groupIds]);

  useEffect(() => {
    ensureHydrated(address);
    setVersion((v) => v + 1);
  }, [address]);

  useEffect(() => {
    return onGroupMembersInvalidated((groupId) => {
      invalidateSidebarGroupMembers(groupId);
      setVersion((v) => v + 1);
    });
  }, []);

  // The roster usually lands before the messaging keypair, so a peer derived from an
  // incomplete identity set is re-derived here once the missing wallet shows up —
  // without refetching membership.
  useEffect(() => {
    if (selfKeys.size === 0) return;
    let changed = false;
    for (const [groupId, addresses] of membersCache) {
      const cached = peerCache.get(groupId);
      if (cached && selfKeys.has(cached)) {
        // A previous pick stored the viewer as the peer: drop it rather than render it.
        peerCache.delete(groupId);
        changed = true;
      }
      const peer = pickDmPeer(addresses, selfKeys);
      if (!peer) continue;
      const next = peer.toLowerCase();
      if (peerCache.get(groupId) !== next) {
        peerCache.set(groupId, next);
        upsertSidebarPeer(address, groupId, peer);
        changed = true;
      }
    }
    if (changed) {
      saveSidebarPeers(address, peerCache);
      setVersion((v) => v + 1);
    }
  }, [selfKeys, address]);

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
            // Single non-self member only: anything else is unresolved, and storing a
            // guess would persist the viewer as this conversation's peer.
            const peer = pickDmPeer(addresses, selfKeysRef.current);
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
      if (peer && !selfKeys.has(peer)) {
        // Include self so the row's avatar filters it out even when membership is unknown.
        map.set(id, [peer, ...selfKeys]);
      } else {
        map.set(id, live ?? []);
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueKey, version, address, selfKeys]);
}
