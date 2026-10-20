import {useCallback} from 'react';
import type {ClientWithCoreApi} from '@socialproof/myso/client';
import type {Ed25519Keypair} from '@socialproof/myso/keypairs/ed25519';
import {useQueryClient} from '@tanstack/react-query';

import {useAgentVault} from '../../contexts/AgentKeyVaultContext';
import {useMessagingClient} from '../../contexts/MessagingClientContext';
import {useMySocialAuth} from '../../contexts/MySocialAuthContext';
import {anchorDedupeKey, anchorNonce, anchorUri, contentDigestV2, expectedDigestHex} from '../../lib/agents/anchor';
import {hasCapability} from '../../lib/agents/capabilities';
import {executeAsAgent} from '../../lib/agents/execute';
import {rememberAnchoredDigest} from '../../lib/agents/pending-digests';
import {anchorAgentMessageTx} from '../../lib/agents/tx';
import {agentKeys} from './query-keys';
import {useAgentChatPlatform} from './useAgentChatPlatform';
import {useAllSubAgents} from './useSubAgents';

export interface AnchorableMessage {
  messageId: string;
  text: string;
  senderAddress: string;
}

const sameAddress = (a: string, b: string) =>
  a.toLowerCase().replace(/^0x0*/, '') === b.toLowerCase().replace(/^0x0*/, '');

/** The indexer trails the chain, so the Verify list is refreshed a couple of times after a commit. */
const REFETCH_DELAYS_MS = [2_500, 6_000];

/**
 * Anchors one agent message on-chain. The agent's own key signs (the contract only accepts the
 * agent as sender), the owner pays gas, and only the message's sha256 plus a pointer go public.
 * The reader of this chat is the recipient, which the contract requires to be a room member.
 */
export function useAnchorMessage(
  groupId: string,
  groupUuid: string,
  recipient: string | null | undefined,
  options: {enabled?: boolean} = {},
) {
  const enabled = options.enabled ?? true;
  const client = useMessagingClient();
  const {keypair} = useMySocialAuth();
  const vault = useAgentVault();
  const queryClient = useQueryClient();
  const platform = useAgentChatPlatform({enabled});
  const agents = useAllSubAgents({enabled});

  return useCallback(
    async (message: AnchorableMessage): Promise<string> => {
      if (!client || !keypair) throw new Error('Sign in before anchoring a message.');
      if (!vault) throw new Error('Unlock agent keys first.');
      if (!recipient) throw new Error('The chat reader is not known yet.');
      if (!message.text.trim()) throw new Error('There is nothing to anchor in this message.');

      const agent = agents.items.find((row) => sameAddress(row.derived_address, message.senderAddress));
      if (!agent) throw new Error('Only a message from one of your own agents can be anchored.');
      if (!agent.active) throw new Error('That agent is deactivated.');
      if (!hasCapability(agent.capabilities, 'MESSAGE_SEND')) {
        throw new Error('That agent needs permission to send messages before it can anchor one.');
      }

      const joined = platform.active ?? (await platform.ensureMembership());
      await vault.ensureUnlocked();
      const epoch = vault.generation();
      const derived = await vault.getAgent(agent);
      vault.assertCurrent(epoch);

      const contentUri = anchorUri(groupUuid, message.messageId);
      const messaging = client.messaging;
      const tx = anchorAgentMessageTx(messaging.packageConfig, {
        groupId: messaging.derive.groupId({uuid: groupUuid}),
        messageLogId: messaging.derive.messageLogId({uuid: groupUuid}),
        platformId: joined.platformId,
        memoryAccountId: agent.account_id,
        recipient,
        contentDigest: contentDigestV2(message.text, groupUuid, message.messageId),
        contentUri,
        dedupeKey: anchorDedupeKey(groupUuid, message.messageId),
        nonce: anchorNonce(),
      });
      const digest = await executeAsAgent(
        client as unknown as ClientWithCoreApi,
        derived.keypair,
        keypair as Ed25519Keypair,
        tx,
        derived.signal,
      );
      rememberAnchoredDigest({
        groupId,
        seq: 0,
        sender: agent.derived_address,
        recipient,
        contentDigest: expectedDigestHex(message.text, {
          version: 2,
          groupUuid,
          messageId: message.messageId,
        }),
        contentUri,
        createdAtMs: Date.now(),
        transactionId: digest,
      });
      for (const delay of REFETCH_DELAYS_MS) {
        window.setTimeout(
          () => void queryClient.invalidateQueries({queryKey: agentKeys.groupDigests(groupId)}),
          delay,
        );
      }
      return digest;
    },
    [client, keypair, vault, recipient, agents.items, platform, groupUuid, groupId, queryClient],
  );
}
