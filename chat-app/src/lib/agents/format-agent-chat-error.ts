/**
 * Turns agent-chat failures into actionable messages.
 *
 * The failure surface spans three layers, so classification matches on both Move abort
 * identifiers (which appear verbatim in the SDK's error text) and transport error codes:
 *  - Move aborts from `messaging::create_agent_and_share_group` and its helpers
 *  - `platform::join_platform` aborts
 *  - relayer/transport errors (membership lag, gas)
 */

export type AgentChatErrorKind =
  | 'platform_not_joined'
  | 'already_joined'
  | 'agent_must_sign'
  | 'missing_capability'
  | 'agent_inactive'
  | 'not_permitted'
  | 'already_exists'
  | 'indexing'
  | 'gas'
  | 'unknown';

export interface AgentChatErrorInfo {
  kind: AgentChatErrorKind;
  message: string;
  /** Whether retrying the same action can plausibly succeed. */
  retryable: boolean;
}

function textOf(error: unknown): string {
  if (error instanceof Error) {
    const extra = error as Error & {code?: string; cause?: string};
    return `${error.message} ${extra.code ?? ''} ${extra.cause ?? ''}`;
  }
  return String(error ?? '');
}

export function classifyAgentChatError(error: unknown): AgentChatErrorInfo {
  const raw = textOf(error);
  const text = raw.toLowerCase();

  if (/ealreadyjoined|already joined/.test(text)) {
    return {
      kind: 'already_joined',
      message: 'This wallet has already joined that platform.',
      retryable: true,
    };
  }

  if (/enotjoined|has_joined_platform|not joined (the )?platform|e_not_joined/.test(text)) {
    return {
      kind: 'platform_not_joined',
      message:
        'Agent chats need a platform membership. Join a platform for this wallet, then create the chat again.',
      retryable: false,
    };
  }

  if (/eagentsendermismatch|agent derived address must sign/.test(text)) {
    return {
      kind: 'agent_must_sign',
      message:
        'This transaction must be signed by the agent key. Re-select the agent and retry from the Agent chats section.',
      retryable: false,
    };
  }

  if (/esubagentmissingcap|cap_message_send|missing cap|esub_agent_missing_cap/.test(text)) {
    return {
      kind: 'missing_capability',
      message:
        'This agent cannot send messages yet. Enable the messaging capability for the agent, then create the chat.',
      retryable: false,
    };
  }

  if (/esubagentnotactive|sub_agent_not_active|revoked|deactivated|not active/.test(text)) {
    return {
      kind: 'agent_inactive',
      message: 'This agent is revoked or deactivated and can no longer start new chats.',
      retryable: false,
    };
  }

  if (/not_group_member/.test(text)) {
    return {
      kind: 'indexing',
      message:
        'The messaging relayer has not indexed this group yet. It usually catches up within a few seconds — retry in a moment.',
      retryable: true,
    };
  }

  if (/no valid gas coins|no rpc-verified gas coins|insufficient gas|gas coin/.test(text)) {
    return {
      kind: 'gas',
      message:
        'The signing account has no usable gas coins. Fund the wallet (or enable gas sponsorship), then retry.',
      retryable: true,
    };
  }

  if (/already exists|eexist|duplicate/.test(text)) {
    return {
      kind: 'already_exists',
      message: 'A chat for this agent already exists. Reload the Agent chats section to open it.',
      retryable: false,
    };
  }

  if (/enotpermitted|not permitted|e_not_permitted/.test(text)) {
    return {
      kind: 'not_permitted',
      message:
        'The platform rejected this action. Confirm the wallet owns the agent\u2019s memory account and has joined an approved platform.',
      retryable: false,
    };
  }

  return {
    kind: 'unknown',
    message: raw.trim() || 'Could not create the agent chat.',
    retryable: true,
  };
}

export function formatAgentChatError(error: unknown): string {
  return classifyAgentChatError(error).message;
}
