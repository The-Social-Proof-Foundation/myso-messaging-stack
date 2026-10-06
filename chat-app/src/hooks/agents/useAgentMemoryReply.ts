import {useCallback, useState} from 'react';
import {createAgentMessagingClient} from '@socialproof/myso-messaging-stack';
import {useQuery} from '@tanstack/react-query';

import {useMessagingClient} from '../../contexts/MessagingClientContext';
import {useMySocialAuth, useAuthenticatedAddress} from '../../contexts/MySocialAuthContext';
import {
  agentChatFromMetadata,
  type GroupMetadataLike,
} from '../../lib/agents/agent-chats';
import {useAgentVault} from '../../contexts/AgentKeyVaultContext';
import {hasCapability} from '../../lib/agents/capabilities';
import {
  askAgent,
  createAgentMemoryClient,
  MemoryClientError,
  rememberAgentFact,
} from '../../lib/agents/memory-client';
import {fetchSubAgentByObjectId} from '../../lib/agents/social-api';
import {useAgentChatPlatform} from './useAgentChatPlatform';
import {useMemoryAccount} from './useMemoryAccount';
import {useSubAgents} from './useSubAgents';

function metadataRecord(parsed: unknown): GroupMetadataLike {
  const row = parsed as {
    name?: string;
    uuid?: string;
    creator?: string;
    data?: {contents?: {key?: string; value?: string}[]};
  } | null;
  const data: Record<string, string> = {};
  for (const entry of row?.data?.contents ?? []) {
    if (entry?.key) data[entry.key] = entry.value ?? '';
  }
  return {
    name: row?.name ?? null,
    uuid: row?.uuid ?? null,
    creator: row?.creator ?? null,
    data,
  };
}

function replyError(error: unknown): string {
  if (!(error instanceof MemoryClientError)) {
    return error instanceof Error ? error.message : 'This agent could not answer.';
  }
  if (error.kind === 'insufficient_credits') return 'This agent is out of AI credits.';
  if (error.kind === 'approval_required') {
    return 'This ask needs a credit approval before the agent can answer.';
  }
  if (error.kind === 'missing_capability') {
    return 'This agent needs memory and AI-spend capabilities before it can answer.';
  }
  return error.message;
}

/**
 * After the user sends in an agent group, ask that agent's own memory and post the
 * answer into the same thread as the agent.
 */
export function useAgentMemoryReply(groupId: string, groupUuid: string) {
  const client = useMessagingClient();
  const {keypair} = useMySocialAuth();
  const owner = useAuthenticatedAddress();
  const vault = useAgentVault();
  const account = useMemoryAccount();
  const [replying, setReplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const metadata = useQuery({
    queryKey: ['agents', 'group-metadata', 'one', groupId],
    enabled: Boolean(client && groupId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<GroupMetadataLike | null> => {
      const rows = await client!.messaging.view.groupsMetadata({
        groupIds: [groupId],
        refresh: false,
      });
      const parsed = rows[groupId];
      return parsed ? metadataRecord(parsed) : null;
    },
  });

  const agentChat = metadata.data
    ? agentChatFromMetadata(groupId, metadata.data)
    : null;
  const agents = useSubAgents(false, {enabled: Boolean(agentChat)});
  const platform = useAgentChatPlatform({enabled: Boolean(agentChat)});

  const reply = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || !client || !keypair) return;
      setError(null);

      let meta = metadata.data;
      if (!meta) {
        try {
          const rows = await client.messaging.view.groupsMetadata({
            groupIds: [groupId],
            refresh: true,
          });
          meta = rows[groupId] ? metadataRecord(rows[groupId]) : null;
        } catch {
          return;
        }
      }
      const ref = meta ? agentChatFromMetadata(groupId, meta) : null;
      if (!ref?.agentObjectId) return;

      setReplying(true);
      try {
        const agent = await fetchSubAgentByObjectId(ref.agentObjectId);
        if (!agent) {
          setError('This agent could not be found.');
          return;
        }
        if (
          !hasCapability(agent.capabilities, 'AI_SPEND') ||
          !hasCapability(agent.capabilities, 'MEMORY_READ')
        ) {
          setError(
            'This agent needs memory and AI-spend capabilities before it can answer.',
          );
          return;
        }
        if (!hasCapability(agent.capabilities, 'MYDATA_READ')) {
          setError('This agent needs Read MyData before it can answer.');
          return;
        }
        if (!hasCapability(agent.capabilities, 'MEMORY_WRITE')) {
          setError('This agent needs write memory before it can remember this chat.');
          return;
        }
        const memoryAccountId = account.data?.account_id;
        if (!memoryAccountId) {
          setError('A memory account is required before this agent can answer.');
          return;
        }

        if (!vault || !owner) throw new Error('Unlock agent keys first.');
        if (!hasCapability(agent.capabilities, 'MESSAGE_SEND')) throw new Error('This agent needs permission to send messages.');
        if (agent.account_id !== memoryAccountId || ref.creatorActor !== agent.derived_address) throw new Error('Chat agent binding mismatch');
        const epoch = vault.generation();
        const derived = await vault.getAgent(agent);
        const memory = createAgentMemoryClient(derived, memoryAccountId);
        let result;
        try {
          vault.assertCurrent(epoch);
          await rememberAgentFact(memory, text);
          vault.assertCurrent(epoch);
          result = await askAgent(memory, {question: text});
          vault.assertCurrent(epoch);
        } finally {memory.destroy();}
        const answer = result.answer.trim() || "I don't have anything in memory for that.";

        vault.assertCurrent(epoch);
        const joined = platform.active ?? (await platform.ensureMembership());
        const agentClient = createAgentMessagingClient({
          messaging: client.messaging,
          agent: {
            agentSigner: derived.keypair,
            subAgentId: agent.agent_object_id,
            principalOwner: owner,
            identityClass: 1,
            memoryAccountId,
            platformId: joined.platformId,
          },
        });
        await agentClient.sendMessage({
          groupRef: {uuid: groupUuid},
          text: answer,
        });
      } catch (err) {
        setError(replyError(err));
      } finally {
        setReplying(false);
      }
    },
    [
      vault, owner,
      account.data?.account_id,
      agents.totalCount,
      client,
      groupId,
      groupUuid,
      keypair,
      metadata.data,
      platform,
    ],
  );

  return {reply, replying, error};
}
