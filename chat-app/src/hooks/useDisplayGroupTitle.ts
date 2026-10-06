import { useMemo } from 'react';
import { useAuthenticatedAddress } from '../contexts/MySocialAuthContext';
import { useMessagingMemberAddress } from '../contexts/MessagingClientContext';
import {
  conversationDisplayTitle,
  dmPeerAddress,
  selfGroupNameLabelsForIdentities,
} from '../lib/wallet-profile';
import { conversationPeerLabel } from '../lib/agents/agent-display-name';
import { useAgentNamesByAddress } from './agents/useSubAgents';
import { useOwnWalletProfile } from './useOwnWalletProfile';
import { useWalletAvatarMap } from './useWalletAvatarMap';

/**
 * Sidebar / chat-header title.
 * 1:1 → the other member's name. An agent uses its label; a person uses their profile.
 * Multi-member groups → official name minus self.
 */
export function useDisplayGroupTitle(
  officialName: string,
  memberAddresses: readonly string[] = [],
): string {
  const address = useAuthenticatedAddress();
  const messagingAddress = useMessagingMemberAddress();
  const selfAddresses = useMemo(
    () => [messagingAddress, address],
    [messagingAddress, address],
  );
  const { profile } = useOwnWalletProfile();
  const peer = useMemo(
    () => dmPeerAddress(memberAddresses, selfAddresses),
    [memberAddresses, selfAddresses],
  );
  const peerAddrs = useMemo(() => (peer ? [peer] : []), [peer]);
  const profiles = useWalletAvatarMap(peerAddrs);
  const agentNames = useAgentNamesByAddress();

  return useMemo(() => {
    const selfLabels = selfGroupNameLabelsForIdentities(selfAddresses, profile);
    return conversationDisplayTitle({
      officialName,
      selfLabels,
      memberAddresses,
      selfAddress: selfAddresses,
      peerLabel: conversationPeerLabel(
        peer,
        agentNames,
        peer ? profiles.labelFor(peer) : null,
      ),
    });
  }, [officialName, selfAddresses, profile, memberAddresses, peer, profiles, agentNames]);
}
