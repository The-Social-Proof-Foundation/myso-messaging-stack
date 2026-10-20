import {useCallback, useEffect, useRef, useSyncExternalStore} from 'react';
import {createAgentMessagingClient} from '@socialproof/myso-messaging-stack';
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
import {
  enqueueAgentReply,
  getAgentReplySession,
  holdAgentReplyQueue,
  patchAgentReplySession,
  resolveAgentReplyAction,
  resumeAgentReplyQueue,
  setAgentReplyResolver,
  setAgentReplyRunner,
  subscribeAgentReplies,
  type AgentReplyJob,
  type PendingChatAction,
} from '../../lib/agents/agent-reply-sessions';
import {RECALL_STATUS_MS, REPLY_STATUS, actionStatus} from '../../lib/agents/reply-status';
import {describeCapabilities, type OrgMemoryAccess} from '../../lib/agents/capability-brief';
import {
  CONTINUE_PROMPT,
  MAX_CONTINUATIONS,
  MAX_LOOKUP_ROUNDS,
  joinContinuation,
  lookupFollowUp,
  orgMemoryAccessFor,
} from '../../lib/agents/chat-action-run';
import {ORG_PERM_MEMORY_READ, ORG_PERM_MEMORY_WRITE} from '@socialproof/memory/account';
import {parseActionProposal} from '../../lib/agents/chat-actions';
import {fetchOrganizationMemoryPermissions, fetchSubAgentByObjectId} from '../../lib/agents/social-api';
import {isTransientMyDataError, withMyDataRetry} from '../../lib/format-relayer-error';
import {useAgentChatPlatform} from './useAgentChatPlatform';
import {useChatActionExecutor} from './useChatActionExecutor';
import {useMemoryAccount} from './useMemoryAccount';
import {useAllSubAgents} from './useSubAgents';
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
  if (error.kind === 'insufficient_credits') return 'This agent is out of AI credits. Deposit credits from the Credits menu to keep chatting.';
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
  orgMemory: OrgMemoryAccess | null | undefined,
): string {
  return `${describeAgent(agent, all, orgName)}\n${describeCapabilities(agent, orgMemory)}\n${AGENT_MEMORY_NOTE}`;
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
  const lines = [`Name: ${name(agent)}`, `Your agent id: ${agent.agent_object_id}`];
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

export type {PendingChatAction};

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
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const session = useSyncExternalStore(
    subscribeAgentReplies,
    () => getAgentReplySession(groupId),
    () => getAgentReplySession(groupId),
  );
  const reply = useCallback(
    (question: string) => {
      enqueueAgentReply({
        groupId,
        groupUuid,
        question,
        historyLength: optionsRef.current.historyLength ?? 0,
        thread: optionsRef.current.thread ?? [],
      });
    },
    [groupId, groupUuid],
  );
  const resolveAction = useCallback(
    (approve: boolean) => resolveAgentReplyAction(groupId, approve),
    [groupId],
  );
  return {
    reply,
    replying: session.replying,
    queued: session.queued,
    status: session.status,
    error: session.error,
    pendingAction: session.pending,
    actionBusy: session.actionBusy,
    resolveAction,
  };
}

interface ReplyDeps {
  client: ReturnType<typeof useMessagingClient>;
  keypair: ReturnType<typeof useMySocialAuth>['keypair'];
  owner: string | null | undefined;
  vault: ReturnType<typeof useAgentVault>;
  accountId: string | undefined;
  organizations: ReturnType<typeof useOrganizations>['organizations'];
  allAgents: SubAgentRow[];
  platform: ReturnType<typeof useAgentChatPlatform>;
  runAction: ReturnType<typeof useChatActionExecutor>;
}

/**
 * Lives for the whole signed-in session, not for the open chat. Each chat has its own queue, so
 * leaving a conversation does not cancel the agent that is already thinking there.
 */
export function AgentReplyEngine() {
  const client = useMessagingClient();
  const {keypair} = useMySocialAuth();
  const owner = useAuthenticatedAddress();
  const vault = useAgentVault();
  const account = useMemoryAccount();
  const runAction = useChatActionExecutor();
  const platform = useAgentChatPlatform();
  const allAgents = useAllSubAgents();
  const {organizations} = useOrganizations();
  const latest = useRef<ReplyDeps>({
    client,
    keypair,
    owner,
    vault,
    accountId: account.data?.account_id,
    organizations,
    allAgents: allAgents.items,
    platform,
    runAction,
  });
  latest.current = {
    client,
    keypair,
    owner,
    vault,
    accountId: account.data?.account_id,
    organizations,
    allAgents: allAgents.items,
    platform,
    runAction,
  };
  useEffect(() => {
    setAgentReplyRunner((job) => runAgentReply(latest.current, job));
    setAgentReplyResolver((groupId, approve) => resolveStoredAction(latest.current, groupId, approve));
    return () => {
      setAgentReplyRunner(null);
      setAgentReplyResolver(null);
    };
  }, []);
  return null;
}

async function runAgentReply(deps: ReplyDeps, job: AgentReplyJob) {
  const {client, keypair, owner, vault, platform, runAction} = deps;
  const {groupId, groupUuid} = job;
  const historyLength = job.historyLength;
  const account = {data: deps.accountId ? {account_id: deps.accountId} : undefined};
  const allAgents = {items: deps.allAgents};
  const organizations = deps.organizations;
  let recallTimer: number | null = null;
  const setStatus = (next: string | null | ((current: string | null) => string | null)) => {
    const current = getAgentReplySession(groupId).status;
    patchAgentReplySession(groupId, {status: typeof next === 'function' ? next(current) : next});
  };
  const setError = (error: string | null) => patchAgentReplySession(groupId, {error});
  const setReplying = (replying: boolean) => patchAgentReplySession(groupId, {replying});
  const setPending = (pending: PendingChatAction | null) => {
    patchAgentReplySession(groupId, {pending});
    if (pending) holdAgentReplyQueue(groupId);
    else resumeAgentReplyQueue(groupId);
  };
  const text = job.question.trim();
  if (!text || !client || !keypair) return;
  setError(null);

  let meta: GroupMetadataLike | null = null;
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
      setStatus(REPLY_STATUS.preparing);
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
          // The chain, not the model, says whether this agent can touch the org's shared memory.
          let orgMemory: OrgMemoryAccess | null | undefined;
          if (!agent.organization_id) orgMemory = null;
          else {
            try {
              const rows = await fetchOrganizationMemoryPermissions(agent.organization_id, keypair, {
                limit: 100,
                offset: 0,
                member: agent.derived_address,
                activeOnly: true,
              });
              orgMemory = {
                organizationName: orgName,
                ...orgMemoryAccessFor(rows.items, agent.derived_address, {
                  read: ORG_PERM_MEMORY_READ,
                  write: ORG_PERM_MEMORY_WRITE,
                }),
              };
            } catch {
              orgMemory = undefined;
            }
          }
          const command = parseAgentCommand(text);
          const remember = decideRemember(text);
          if (remember.facts.length > 0) setStatus(REPLY_STATUS.saving);
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
          for (const m of job.thread) {
            const content = m.text?.trim();
            if (!content) continue;
            turns.push({
              role: m.senderAddress && m.senderAddress.toLowerCase() === agent.derived_address.toLowerCase() ? 'assistant' : 'user',
              content,
            });
          }
          // Answer from what had been said when this question was asked: with messages queued behind
          // it, the thread already holds later ones the agent has not reached yet.
          for (let i = turns.length - 1; i >= 0; i -= 1) {
            if (turns[i]!.role === 'user' && turns[i]!.content === text) {
              turns.length = i;
              break;
            }
          }
          const agentProfile = buildAgentProfile(agent, allAgents.items, orgName, orgMemory);
          if (localAnswer === null) {
            setStatus(decision.recall ? REPLY_STATUS.recalling : REPLY_STATUS.thinking);
            if (decision.recall) {
              recallTimer = window.setTimeout(
                () => setStatus((current) => (current === REPLY_STATUS.recalling ? REPLY_STATUS.thinking : current)),
                RECALL_STATUS_MS,
              );
            }
          }
          if (localAnswer === null) result = await askAgent(memory, {
            question: text,
            history: turns.slice(-12),
            agentProfile,
            recall: decision.recall,
            idempotencyKey: await turnIdempotencyKey(groupId, text),
          });
          if (recallTimer !== null) {
            window.clearTimeout(recallTimer);
            recallTimer = null;
          }
          vault.assertCurrent(epoch);
          // A lookup in the social indexer only reads, so it runs at once and its result goes back to
          // the model, which then answers from real data instead of guessing.
          if (result) {
            for (let round = 0; round < MAX_LOOKUP_ROUNDS; round += 1) {
              const asked = parseActionProposal(result.answer.trim(), agent);
              const lookup = asked.proposal;
              if (!lookup?.def.feedsBack) break;
              setStatus(actionStatus(lookup.def.title));
              let data: string;
              try {
                data = await runAction(lookup, agent);
              } catch (err) {
                data = `The lookup failed: ${replyError(err)}`;
              }
              vault.assertCurrent(epoch);
              setStatus(REPLY_STATUS.thinking);
              result = await askAgent(memory, {
                question: lookupFollowUp(lookup.name, data, round === MAX_LOOKUP_ROUNDS - 1),
                history: [
                  ...turns.slice(-10),
                  {role: 'user', content: text},
                  {role: 'assistant', content: asked.text || `Looking that up with ${lookup.name}.`},
                ],
                agentProfile,
                recall: false,
                idempotencyKey: await turnIdempotencyKey(groupId, `${text}\u0000lookup${round}`),
              });
              vault.assertCurrent(epoch);
            }
          }
          // A reply that hit the output limit stops mid-thought. Ask for the rest and stitch it on,
          // rather than posting half an answer.
          for (let part = 0; result?.truncated && part < MAX_CONTINUATIONS; part += 1) {
            setStatus(REPLY_STATUS.finishing);
            const rest = await askAgent(memory, {
              question: CONTINUE_PROMPT,
              history: [...turns.slice(-10), {role: 'user', content: text}, {role: 'assistant', content: result.answer}],
              agentProfile,
              recall: false,
              idempotencyKey: await turnIdempotencyKey(groupId, `${text}\u0000continue${part}`),
            });
            vault.assertCurrent(epoch);
            result = {...rest, answer: joinContinuation(result.answer, rest.answer)};
          }
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
        const modelAnswer = localAnswer ?? (result?.answer.trim() || "I don't have anything in memory for that.");
        // Only model output can carry an action; local /command answers never do.
        const parsed = localAnswer === null ? parseActionProposal(modelAnswer, agent) : null;
        let answer = parsed ? parsed.text : modelAnswer;
        if (parsed?.problem) answer = [answer, parsed.problem].filter(Boolean).join('\n\n');
        let readResult: string | null = null;
        if (parsed?.proposal?.def.risk === 'auto') {
          setStatus(actionStatus(parsed.proposal.def.title));
          try {
            readResult = await runAction(parsed.proposal, agent);
          } catch (err) {
            readResult = `I couldn't do that: ${replyError(err)}`;
          }
        }
        if (readResult) answer = [answer, readResult].filter(Boolean).join('\n\n');
        const writeProposal = parsed?.proposal?.def.risk === 'approval' ? parsed.proposal : null;
        if (writeProposal && !answer) {
          answer = `I'd like to ${writeProposal.def.title.toLowerCase()}. It needs your OK first.`;
        }

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
        setStatus(REPLY_STATUS.sending);
        const post = (text: string) =>
          // The answer is already generated and billed — retry key-server blips so it lands.
          withMyDataRetry(() =>
            agentClient.sendMessage({
              groupRef: {uuid: groupUuid},
              text,
            }),
          );
        await post(answer);
        setPending(writeProposal ? {proposal: writeProposal, agent, post} : null);
      } catch (err) {
        setError(replyError(err));
      } finally {
        if (recallTimer !== null) {
          window.clearTimeout(recallTimer);
          recallTimer = null;
        }
        setReplying(false);
        setStatus(null);
      }
}

async function resolveStoredAction(deps: ReplyDeps, groupId: string, approve: boolean) {
  const pending = getAgentReplySession(groupId).pending;
  const {actionBusy} = getAgentReplySession(groupId);
  if (!pending || actionBusy) return;
  const setError = (error: string | null) => patchAgentReplySession(groupId, {error});
  const setPending = (next: PendingChatAction | null) => {
    patchAgentReplySession(groupId, {pending: next});
    if (next) holdAgentReplyQueue(groupId);
    else resumeAgentReplyQueue(groupId);
  };
  patchAgentReplySession(groupId, {actionBusy: true});
  setError(null);
  try {
    if (!approve) {
      await pending.post("Understood, I won't do that.");
      setPending(null);
      return;
    }
    const fresh = await fetchSubAgentByObjectId(pending.agent.agent_object_id);
    const current = fresh ? parseActionProposal(`[[action:${pending.proposal.name} ${JSON.stringify(pending.proposal.params)}]]`, fresh) : null;
    if (!fresh || !fresh.active || !current?.proposal) {
      throw new Error('This agent no longer has permission to do that.');
    }
    let message: string;
    try {
      message = await deps.runAction(current.proposal, fresh);
    } catch (err) {
      message = `I couldn't do that: ${replyError(err)}`;
    }
    setPending(null);
    await pending.post(message);
  } catch (err) {
    setError(replyError(err));
    setPending(null);
  } finally {
    patchAgentReplySession(groupId, {actionBusy: false});
  }
}
