import { zkLoginRelayerSigner } from '@socialproof/myso-messaging-stack';
import type { Signer } from '@socialproof/myso/cryptography';

import {
  zkLoginChainAddress,
  zkLoginEphemeralKeypair,
  zkLoginPersonalMessageSignature,
} from './zklogin-signin';

/**
 * Who the relayer authenticates a call as.
 *
 * A zkLogin user's messaging key is the proof's ephemeral key, but groups list the zkLogin
 * account as the member. So relayer calls made with that key authenticate as the zkLogin
 * account (its proof wraps the ephemeral signature). MyData session-key certificates use it too,
 * so key servers check the zkLogin account's group membership. Per-message signatures and
 * transactions keep the ephemeral key. Any other signer (wallets, agents) is unchanged.
 */
export function relayerAuthSigner(signer: Signer): Signer {
  const zkAddress = zkLoginChainAddress();
  const ephemeral = zkLoginEphemeralKeypair();
  if (!zkAddress || !ephemeral) return signer;
  if (signer.toMySoAddress().toLowerCase() !== ephemeral.toMySoAddress().toLowerCase()) {
    return signer;
  }
  return zkLoginRelayerSigner(signer, {
    address: zkAddress,
    signPersonalMessage: async (bytes) => {
      const signature = await zkLoginPersonalMessageSignature(bytes);
      if (!signature) {
        throw new Error('Sign in again so this zkLogin account can message.');
      }
      return signature;
    },
  });
}
