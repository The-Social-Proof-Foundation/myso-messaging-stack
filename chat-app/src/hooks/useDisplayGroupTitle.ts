import { useMemo } from 'react';
import { useAuthenticatedAddress } from '../contexts/MySocialAuthContext';
import {
  conversationDisplayTitle,
  dmPeerAddress,
  selfGroupNameLabels,
} from '../lib/wallet-profile';
import { useOwnWalletProfile } from './useOwnWalletProfile';
import { useWalletAvatarMap } from './useWalletAvatarMap';

/**
 * Sidebar / chat-header title.
 * 1:1 → other member's profile label; groups → official name minus self.
 */
export function useDisplayGroupTitle(
  officialName: string,
  memberAddresses: readonly string[] = [],
): string {
  const address = useAuthenticatedAddress();
  const { profile } = useOwnWalletProfile();
  const peer = useMemo(
    () => dmPeerAddress(memberAddresses, address),
    [memberAddresses, address],
  );
  const peerAddrs = useMemo(() => (peer ? [peer] : []), [peer]);
  const profiles = useWalletAvatarMap(peerAddrs);

  return useMemo(() => {
    const selfLabels = selfGroupNameLabels(address, profile);
    return conversationDisplayTitle({
      officialName,
      selfLabels,
      memberAddresses,
      selfAddress: address,
      peerLabel: peer ? profiles.labelFor(peer) : null,
    });
  }, [officialName, address, profile, memberAddresses, peer, profiles]);
}
