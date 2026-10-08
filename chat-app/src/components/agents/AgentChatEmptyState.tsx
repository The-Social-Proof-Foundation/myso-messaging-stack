import {MessageSquarePlus} from 'lucide-react';

import type {SubAgentRow} from '../../lib/agents/social-api';
import {truncateAddress} from '../../lib/agents/format';
import type {AgentChatErrorInfo} from '../../lib/agents/format-agent-chat-error';
import {AGENT_CHAT_STAGE_LABEL, type AgentChatStage} from '../../hooks/agents/useAgentChatActions';
import {Button} from '../Button';
import {ErrorNotice} from './ErrorNotice';

interface AgentChatEmptyStateProps {
  agent: SubAgentRow;
  canChat: boolean;
  stage: AgentChatStage | null;
  error: AgentChatErrorInfo | null;
  onStartChat: () => void;
  onEnableMessaging: () => void;
}

/**
 * Shown in the main pane when an agent is selected but its chat has not been started yet.
 *
 * Kept deliberately small: starting the chat is the only primary action, so there is no
 * second conversation surface competing with the real one.
 */
export function AgentChatEmptyState({
  agent,
  canChat,
  stage,
  error,
  onStartChat,
  onEnableMessaging,
}: Readonly<AgentChatEmptyStateProps>) {
  const inactive = !agent.active || Boolean(agent.revoked_at_ms);

  return (
    <div className="flex flex-1 items-center justify-center px-8">
      <div className="max-w-md text-center">
        <h2 className="font-chakra text-lg font-semibold tracking-wide text-secondary-900 dark:text-secondary-100">
          {agent.label}
        </h2>
        <p className="mt-1 text-xs text-secondary-400 dark:text-secondary-500">
          {truncateAddress(agent.derived_address)}
        </p>

        {inactive ? (
          <p className="mt-4 text-sm text-secondary-500 dark:text-secondary-400">
            This agent is {agent.revoked_at_ms ? 'revoked' : 'deactivated'} and cannot start new
            chats.
          </p>
        ) : !canChat ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-secondary-600 dark:text-secondary-300">
              This agent cannot send messages yet. Enable messaging for it, then start the chat.
            </p>
            <Button onClick={onEnableMessaging}>Enable messaging</Button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-secondary-500 dark:text-secondary-400">
              No chat with this agent yet.
            </p>
            <Button onClick={onStartChat} disabled={Boolean(stage)}>
              <MessageSquarePlus className="mr-1.5 h-4 w-4" aria-hidden />
              {stage ? AGENT_CHAT_STAGE_LABEL[stage] : 'Start chat'}
            </Button>
          </div>
        )}

        {error ? (
          <ErrorNotice className="mt-4">{error.message}</ErrorNotice>
        ) : null}
      </div>
    </div>
  );
}
