import {CHAT_ACTIONS, chatActionProtocol} from './chat-actions';
import {CAP, CAPABILITY_NAMES, type CapabilityName} from './capabilities';

/** What each on-chain capability lets an agent do, in a phrase the model can repeat. */
const CAPABILITY_MEANING: Record<CapabilityName, string> = {
  MEMORY_READ: 'read its stored memories',
  MEMORY_WRITE: 'save durable memories',
  MYDATA_READ: 'read MyData it has been given access to',
  POST_PUBLISH: 'publish posts',
  MESSAGE_READ: 'read messages in chats it belongs to',
  MESSAGE_SEND: 'send messages in chats it belongs to',
  TRADE_MONITOR: 'monitor trades',
  TRADE_EXECUTE: 'execute trades',
  COMMENT: 'comment on posts',
  REACT: 'react to posts and messages',
  AGENT_REVOKE: 'revoke agents below it',
  AGENT_UPDATE: 'update agents below it',
  AGENT_REGISTER: 'register new sub-agents',
  AI_SPEND: 'spend AI credits (this is what powers its replies)',
  BUDGET_MANAGE: 'manage AI-credit budgets for agents below it',
  SOCIAL_GRAPH: 'follow, unfollow, block and unblock for its principal',
  TASK_TRADE: 'create, accept, deliver, settle, refund and review tasks in the task market',
  JURY: 'serve on AI juries: accept a seat, commit and reveal a vote, claim the fee',
};

/**
 * Tells the model what its own permissions are and the one way it may act. The reply path is plain
 * text generation, so the model only proposes; the app validates and the owner approves.
 */
/** The agent's real access to the organization's shared memory, as the chain reports it. */
export interface OrgMemoryAccess {
  organizationName: string | null;
  read: boolean;
  write: boolean;
}

function describeMemoryAccess(access: OrgMemoryAccess | null | undefined): string {
  if (access === undefined) return '';
  if (access === null) {
    return 'Memory: you have your own private memory. You are not in an organization, so there is no shared org memory.';
  }
  const org = access.organizationName ? ` (${access.organizationName})` : '';
  const state =
    access.read && access.write
      ? 'you can read and write it'
      : access.read
        ? 'you can read it but not write to it'
        : access.write
          ? 'you can write to it but not read it'
          : 'you have no access to it yet; if asked, say so and offer grant_org_memory for yourself';
  return (
    `Memory: your private memory is yours alone. The organization${org} also has shared memory that ` +
    `every member with access can use; ${state}.`
  );
}

/**
 * Tells the model what its own permissions are and the one way it may act. The reply path is plain
 * text generation, so the model only proposes; the app validates and the owner approves.
 */
export function describeCapabilities(
  agent: {capabilities: number; delegatable_caps: number; expires_at_ms: number | null},
  orgMemory?: OrgMemoryAccess | null,
): string {
  const held = CAPABILITY_NAMES.filter((name) => (agent.capabilities & CAP[name]) !== 0);
  const delegable = CAPABILITY_NAMES.filter(
    (name) => (agent.delegatable_caps & CAP[name]) !== 0,
  );
  const lines = [
    held.length
      ? `Your on-chain capabilities (granted to your agent key by your owner): ${held
          .map((name) => CAPABILITY_MEANING[name])
          .join('; ')}.`
      : 'Your agent key has no on-chain capabilities granted.',
    'Anything not listed is not granted to you.',
  ];
  if (delegable.length && delegable.length !== held.length) {
    lines.push(`You can delegate only: ${delegable.map((name) => name.toLowerCase()).join(', ')}.`);
  }
  if (agent.expires_at_ms) {
    lines.push(`Your authority expires ${new Date(agent.expires_at_ms).toISOString()}.`);
  }
  const memory = describeMemoryAccess(orgMemory);
  if (memory) lines.push(memory);
  lines.push(
    'You never sign or send a transaction yourself. In this chat you converse, recall and save ' +
      'memory, answer /commands, and propose actions.',
  );
  const protocol = chatActionProtocol(agent);
  if (protocol) lines.push(protocol);
  const usable = new Set(Object.values(CHAT_ACTIONS).map((def) => def.capability));
  const appOnly = held.filter((name) => !usable.has(name));
  if (appOnly.length) {
    lines.push(
      `Permissions you hold but cannot use from chat (they run through the app, so say so and offer to plan it): ${appOnly
        .map((name) => name.toLowerCase())
        .join(', ')}.`,
    );
  }
  return lines.join(' ');
}
