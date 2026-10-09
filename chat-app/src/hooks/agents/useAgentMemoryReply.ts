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
  type AskHistoryTurn,
  createAgentMemoryClient,
  MemoryClientError,
  rememberAgentFacts,
  recallAgentMemories,
} from '../../lib/agents/memory-client';
import {assertAgentAccountBinding, CrossAccountMemoryError} from '../../lib/agents/account-isolation';
import {
  AGENT_COMMAND_HELP,
  AGENT_MEMORY_NOTE,
  decideRecall,
  decideRemember,
  parseAgentCommand,
  turnIdempotencyKey,
  type AgentCommand,
} from '../../lib/agents/memory-turn';
import {fetchSubAgentByObjectId} from '../../lib/agents/social-api';
import {isTransientMyDataError, withMyDataRetry} from '../../lib/format-relayer-error';
import {useAgentChatPlatform} from './useAgentChatPlatform';
import {useMemoryAccount} from './useMemoryAccount';
import {useAllSubAgents, useSubAgents} from './useSubAgents';
import {useOrganizations} from './useOrganizations';
import type {SubAgentRow} from '../../lib/agents/social-api';

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
  if (error instanceof CrossAccountMemoryError) return error.message;
  if (isTransientMyDataError(error)) {
    return 'Encryption keys are temporarily unavailable, so the agent reply could not be posted. Try again.';
  }
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
  if (error.kind === 'unreachable') {
    return 'Memory is temporarily unavailable, so this agent cannot answer right now. Try again shortly.';
  }
  return error.message;
}

export interface AgentMemoryReplyOptions {
  /** Turns already in the thread; a short follow-up needs memory once there is context. */
  historyLength?: number;
  /** Recent text messages, oldest first, so the agent sees the conversation it is in. */
  thread?: {senderAddress?: string | null; text?: string | null}[];
}


/** Answers a local command from the chat itself: no model call, no AI-credit spend. */
async function answerCommand(
  command: AgentCommand,
  ctx: {
    memory: ReturnType<typeof createAgentMemoryClient>;
    saved: Awaited<ReturnType<typeof rememberAgentFacts>> | null;
    profile: string;
    hadFact: boolean;
  },
): Promise<string> {
  switch (command.name) {
    case 'help':
      return `Commands:\n${AGENT_COMMAND_HELP}`;
    case 'whoami':
      return ctx.profile;
    case 'remember':
      if (!ctx.hadFact) return 'Tell me what to remember, e.g. /remember I prefer concise summaries.';
      return ctx.saved && ctx.saved.written > 0
        ? 'Saved to memory.'
        : 'I already have that in memory.';
    case 'recall': {
      if (!command.args) return 'Tell me what to look up, e.g. /recall my favourite colour.';
      const {memories, truncated} = await recallAgentMemories(ctx.memory, command.args);
      if (memories.length === 0) return `I have nothing stored about "${command.args}".`;
      const lines = memories.map((m) => `• ${m.text}`);
      return `${lines.join('\n')}${truncated ? '\n…there may be more; narrow the topic.' : ''}`;
    }
  }
}

/** Plain-text identity for the model: name, organization, who it reports to, who reports to it. */
function buildAgentProfile(
  agent: SubAgentRow,
  all: SubAgentRow[],
  orgName: string | null,
): string {
  return `${describeAgent(agent, all, orgName)}\n${AGENT_MEMORY_NOTE}`;
}

function describeAgent(
  agent: SubAgentRow,
  all: SubAgentRow[],
  orgName: string | null,
): string {
  const name = (row: SubAgentRow) => row.label?.trim() || row.agent_object_id.slice(0, 10);
  const parent = agent.parent_object_id
    ? all.find((row) => row.agent_object_id === agent.parent_object_id)
    : undefined;
  const reports = all.filter((row) => row.parent_object_id === agent.agent_object_id);
  const peers = parent
    ? all.filter(
        (row) =>
          row.parent_object_id === parent.agent_object_id &&
          row.agent_object_id !== agent.agent_object_id,
      )
    : [];
  const lines = [`Name: ${name(agent)}`];
  if (orgName) lines.push(`Organization: ${orgName}`);
  lines.push(
    parent
      ? `You report to: ${name(parent)}`
      : 'You report to: no agent (you are a root agent); your human owner is your principal.',
  );
  if (reports.length) lines.push(`Agents that report to you: ${reports.map(name).join(', ')}`);
  if (peers.length) lines.push(`Peer agents (same manager): ${peers.map(name).join(', ')}`);
  return lines.join('\n');
}

/**
 * After the user sends in an agent group, answer as that agent.
 *
 * Memory is used on demand rather than every turn: the question is recalled only
 * when it actually refers to stored facts, and a fact is written only when the
 * turn states something durable. Generation is served by the AI-credit gateway
 * (`chat -> gateway -> OpenRouter`) through the memory server, and the turn
 * carries a stable idempotency key so a retry cannot bill or store twice.
 */
export function useAgentMemoryReply(
  groupId: string,
  groupUuid: string,
  options: AgentMemoryReplyOptions = {},
) {
  const historyLength = options.historyLength ?? 0;
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
  const allAgents = useAllSubAgents({enabled: Boolean(agentChat)});
  const {organizations} = useOrganizations();

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
        // Cross-account guard: refuse to sign with this agent's key against an
        // account it is not registered under, before any memory call goes out.
        assertAgentAccountBinding({
          agentObjectId: agent.agent_object_id,
          agentAccountId: agent.account_id,
          derivedAddress: agent.derived_address,
          chatCreatorActor: ref.creatorActor,
          expectedAccountId: memoryAccountId,
        });
        await vault.ensureUnlocked();
        const epoch = vault.generation();
        const derived = await vault.getAgent(agent);
        const memory = createAgentMemoryClient(derived, memoryAccountId);
        let result;
        let localAnswer: string | null = null;
        try {
          vault.assertCurrent(epoch);
          // Write only when the turn states something durable, then confirm every
          // batch job reached `done` before the agent answers from it.
          const orgId = agent.organization_id?.toLowerCase();
          const orgName = orgId
            ? organizations.find((row) => row.organization_id.toLowerCase() === orgId)?.name?.trim() ?? null
            : null;
          const command = parseAgentCommand(text);
          const remember = decideRemember(text);
          const saved =
            remember.facts.length > 0 ? await rememberAgentFacts(memory, remember.facts) : null;
          if (command) {
            localAnswer = await answerCommand(command, {
              memory,
              saved,
              profile: describeAgent(agent, allAgents.items, orgName),
              hadFact: remember.facts.length > 0,
            });
          }
          vault.assertCurrent(epoch);
          // Recall only when the turn refers to stored facts. `recall: false`
          // answers from the model alone: no embedding, search or MYDATA decrypt.
          const decision = decideRecall(text, historyLength);
          // The user's message is already in the thread; drop it so it is not sent twice.
          const turns: AskHistoryTurn[] = [];
          for (const m of options.thread ?? []) {
            const content = m.text?.trim();
            if (!content) continue;
            turns.push({
              role: m.senderAddress && m.senderAddress.toLowerCase() === agent.derived_address.toLowerCase() ? 'assistant' : 'user',
              content,
            });
          }
          if (turns.length && turns[turns.length - 1].role === 'user' && turns[turns.length - 1].content === text) turns.pop();
          if (localAnswer === null) result = await askAgent(memory, {
            question: text,
            history: turns.slice(-12),
            agentProfile: buildAgentProfile(agent, allAgents.items, orgName),
            recall: decision.recall,
            idempotencyKey: await turnIdempotencyKey(groupId, text),
          });
          vault.assertCurrent(epoch);
          if (result) {
          // A recall that comes back empty is indistinguishable from "never stored" in the
          // answer itself, so say which one the server reported. On the memory server this
          // shows up as "ask: 0 memories found for context" alongside any
          // "MYDATA decrypt failed for <blob>" warnings, which is what makes a stored fact
          // that cannot be read back visible instead of looking like an empty memory.
          if (import.meta.env.DEV && decision.recall && result.memories_used === 0) {
            console.warn(
              '[memory] recall ran but returned no memories this turn ' +
                `(reason=${decision.reason}). Either nothing matching is stored, or the ` +
                'stored blobs could not be decrypted — check the memory server log.',
              { agentObjectId: agent.agent_object_id, question: text },
            );
          }
          }
        } finally {memory.destroy();}
        const answer = localAnswer ?? (result?.answer.trim() || "I don't have anything in memory for that.");

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
        // The answer is already generated and billed — retry key-server blips so it lands.
        await withMyDataRetry(() =>
          agentClient.sendMessage({
            groupRef: {uuid: groupUuid},
            text: answer,
          }),
        );
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
      allAgents.items,
      organizations,
      options.thread,
      client,
      groupId,
      historyLength,
      groupUuid,
      keypair,
      metadata.data,
      platform,
    ],
  );

  return {reply, replying, error};
}
