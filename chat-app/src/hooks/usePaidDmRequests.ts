/**
 * Sidebar paid-DM request detection: for groups with unread messages, checks
 * whether the DM peer paid an escrow to us that a reply would claim
 * (`peerPaid && firstOutbound` from the relayer's dm-gate). Those groups show
 * a PAID badge instead of the unread count.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMessagingClient } from '../contexts/MessagingClientContext';
import { useMySocialAuth } from '../contexts/MySocialAuthContext';
import type { StoredGroup } from '../lib/group-store';

export function usePaidDmRequests(
  groups: StoredGroup[],
  unreadCounts: Record<string, number>,
): Set<string> {
  const client = useMessagingClient();
  const { keypair: signer } = useMySocialAuth();
  const [paidGroupIds, setPaidGroupIds] = useState<Set<string>>(new Set());

  // Latest props via refs so the effect can key on the stable unread-set
  // string instead of re-running on every 15s unread poll.
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const unreadRef = useRef(unreadCounts);
  unreadRef.current = unreadCounts;

  const unreadKey = useMemo(
    () =>
      groups
        .filter((g) => g.uuid && (unreadCounts[g.groupId] ?? 0) > 0)
        .map((g) => g.groupId)
        .sort()
        .join(','),
    [groups, unreadCounts],
  );

  useEffect(() => {
    if (!client || !signer || unreadKey === '') {
      setPaidGroupIds(new Set());
      return;
    }

    const messagingClient = client;
    const messagingSigner = signer;
    const candidates = groupsRef.current.filter(
      (g) => g.uuid && (unreadRef.current[g.groupId] ?? 0) > 0,
    );
    let cancelled = false;

    async function evaluate() {
      const myAddress = messagingSigner.toMySoAddress();
      const systemAddresses =
        messagingClient.messaging.derive.systemObjectAddresses();

      const results = await Promise.all(
        candidates.map(async (group) => {
          try {
            const { members } = await messagingClient.groups.view.getMembers({
              groupId: group.groupId,
              exhaustive: true,
            });
            const peers = (members as { address: string }[]).filter(
              (m) => m.address !== myAddress && !systemAddresses.has(m.address),
            );
            if (peers.length !== 1) return null;

            const gate = await messagingClient.messaging.checkDmGate({
              signer: messagingSigner,
              recipient: peers[0]!.address,
              groupRef: { uuid: group.uuid },
            });
            return gate.peerPaid && gate.firstOutbound ? group.groupId : null;
          } catch (err) {
            console.warn(
              `Paid-DM request check failed for group ${group.groupId}:`,
              err,
            );
            return null;
          }
        }),
      );

      if (!cancelled) {
        setPaidGroupIds(
          new Set(results.filter((id): id is string => id !== null)),
        );
      }
    }

    evaluate().then();
    return () => {
      cancelled = true;
    };
  }, [client, signer, unreadKey]);

  return paidGroupIds;
}
