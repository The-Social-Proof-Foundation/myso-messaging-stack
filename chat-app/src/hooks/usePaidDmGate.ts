/**
 * Advisory paid-DM gate state for the selected 1:1 conversation.
 *
 * Detects an unclaimed escrow the peer paid to us where we have not replied
 * yet (`peerPaid && firstOutbound` from the relayer's dm-gate) so the UI can
 * show a "reply to claim" prompt. Advisory only — enforcement stays in the
 * relayer.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRequiredMessagingClient } from '../contexts/MessagingClientContext';

export interface PaidDmGateState {
  /** The peer escrowed MYSO to us and we have not replied yet. */
  claimPending: boolean;
  /** Latest peer escrow in MIST (set when `claimPending`). */
  peerEscrowAmount: bigint | null;
  /** Re-evaluate the gate (e.g. after sending a reply). */
  refresh: () => void;
}

export function usePaidDmGate(
  group: { uuid: string; groupId: string } | null,
): PaidDmGateState {
  const { client, signer } = useRequiredMessagingClient();
  const [claimPending, setClaimPending] = useState(false);
  const [peerEscrowAmount, setPeerEscrowAmount] = useState<bigint | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  const uuid = group?.uuid ?? null;
  const groupId = group?.groupId ?? null;

  useEffect(() => {
    if (!uuid || !groupId) {
      setClaimPending(false);
      setPeerEscrowAmount(null);
      return;
    }

    let cancelled = false;

    async function check(gid: string, groupUuid: string) {
      try {
        const myAddress = signer.toMySoAddress();
        const systemAddresses = client.messaging.derive.systemObjectAddresses();
        const { members } = await client.groups.view.getMembers({
          groupId: gid,
          exhaustive: true,
        });
        const peers = (members as { address: string }[]).filter(
          (m) => m.address !== myAddress && !systemAddresses.has(m.address),
        );
        if (peers.length !== 1) {
          if (!cancelled) {
            setClaimPending(false);
            setPeerEscrowAmount(null);
          }
          return;
        }

        const gate = await client.messaging.checkDmGate({
          signer,
          recipient: peers[0]!.address,
          groupRef: { uuid: groupUuid },
        });
        if (!cancelled) {
          setClaimPending(gate.peerPaid && gate.firstOutbound);
          setPeerEscrowAmount(gate.peerEscrowAmount);
        }
      } catch (err) {
        console.warn('Paid-DM gate check failed:', err);
        if (!cancelled) {
          setClaimPending(false);
          setPeerEscrowAmount(null);
        }
      }
    }

    check(groupId, uuid).then();
    return () => {
      cancelled = true;
    };
  }, [client, signer, uuid, groupId, refreshTick]);

  return { claimPending, peerEscrowAmount, refresh };
}
