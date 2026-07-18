import type { AgentConversation } from '@socialproof/myso-messaging-stack';
import { ChevronRight } from 'lucide-react';

interface AgentConversationsPanelProps {
  conversations: AgentConversation[];
  loading?: boolean;
  error?: string | null;
  onSelectGroup?: (groupId: string) => void;
}

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function AgentConversationsPanel({
  conversations,
  loading = false,
  error = null,
  onSelectGroup,
}: Readonly<AgentConversationsPanelProps>) {
  return (
    <section className="border-b border-secondary-200 py-3 dark:border-secondary-700">
      <div className="flex items-center gap-2 px-4 py-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium tracking-wide text-secondary-500 dark:text-secondary-400">
          Sub-agent Conversations
        </h3>
        {loading && (
          <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
        )}
        <ChevronRight
          className="h-4 w-4 shrink-0 text-secondary-400 dark:text-secondary-500"
          strokeWidth={2}
          aria-hidden
        />
      </div>
      {error && (
        <p className="px-4 pb-2 text-xs text-danger-500">{error}</p>
      )}
      {conversations.length === 0 && !loading && !error ? (
        <p className="px-4 pb-2 text-xs text-secondary-400 dark:text-secondary-500">
          No agent-associated groups indexed yet.
        </p>
      ) : (
        <ul className="max-h-40 overflow-y-auto">
          {conversations.map((conv) => (
            <li
              key={conv.groupId}
              className="border-t border-secondary-200 dark:border-secondary-700"
            >
              <button
                type="button"
                onClick={() => onSelectGroup?.(conv.groupId)}
                className="w-full px-4 py-2.5 text-left hover:bg-secondary-50 dark:hover:bg-secondary-700/50"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-secondary-800 dark:text-secondary-100">
                    {conv.groupName ?? conv.groupUuid ?? 'Agent group'}
                  </span>
                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-secondary-400 dark:text-secondary-500"
                    strokeWidth={2}
                    aria-hidden
                  />
                </div>
                <span className="mt-0.5 block text-xs text-secondary-500 dark:text-secondary-400">
                  Agent {truncateAddress(conv.creatorActor ?? 'unknown')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
