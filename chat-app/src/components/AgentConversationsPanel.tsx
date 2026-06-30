import type { AgentConversation } from '@socialproof/myso-messaging-stack';

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
    <section className="border-b border-secondary-200 dark:border-secondary-700">
      <div className="flex items-center justify-between px-4 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary-500 dark:text-secondary-400">
          Agent conversations
        </h3>
        {loading && (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
        )}
      </div>
      {error && (
        <p className="px-4 pb-2 text-xs text-danger-500">{error}</p>
      )}
      {conversations.length === 0 && !loading && !error ? (
        <p className="px-4 pb-3 text-xs text-secondary-400 dark:text-secondary-500">
          No agent-associated groups indexed yet.
        </p>
      ) : (
        <ul className="max-h-40 overflow-y-auto pb-2">
          {conversations.map((conv) => (
            <li key={conv.groupId}>
              <button
                type="button"
                onClick={() => onSelectGroup?.(conv.groupId)}
                className="flex w-full flex-col gap-0.5 px-4 py-2 text-left hover:bg-secondary-50 dark:hover:bg-secondary-700/50"
              >
                <span className="truncate text-sm font-medium text-secondary-800 dark:text-secondary-100">
                  {conv.groupName ?? conv.groupUuid ?? 'Agent group'}
                </span>
                <span className="text-xs text-secondary-500 dark:text-secondary-400">
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
