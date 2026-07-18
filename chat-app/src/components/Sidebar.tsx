import type { StoredGroup } from '../lib/group-store';
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

interface SidebarProps {
  groups: StoredGroup[];
  selectedUuid: string | null;
  unreadCounts?: Record<string, number>;
  /** Groups whose unread messages are paid-DM requests (reply claims escrow). */
  paidDmGroupIds?: Set<string>;
  onSelectGroup: (uuid: string) => void;
  loading?: boolean;
  agentPanel?: ReactNode;
}

export function Sidebar({
  groups,
  selectedUuid,
  unreadCounts = {},
  paidDmGroupIds,
  onSelectGroup,
  loading = false,
  agentPanel,
}: Readonly<SidebarProps>) {
  return (
    <aside className="flex h-full min-h-0 w-full flex-1 flex-col bg-white md:w-72 md:shrink-0 md:border-r md:border-secondary-200/80 dark:bg-secondary-900 dark:md:border-secondary-700">
      {agentPanel}

      {/* Group list */}
      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-secondary-400 dark:text-secondary-500">
            {loading ? (
              'Discovering groups...'
            ) : (
              <>
                No groups yet.
                <br />
                Create or join one!
              </>
            )}
          </div>
        ) : (
          <ul>
            {groups.map((group) => {
              const unread = unreadCounts[group.groupId] ?? 0;
              const isPaidRequest = paidDmGroupIds?.has(group.groupId) ?? false;
              const selected =
                (selectedUuid === group.uuid ||
                  selectedUuid === group.groupId) &&
                !!selectedUuid;
              return (
                <li
                  key={group.uuid || group.groupId}
                  className="border-b border-secondary-200 dark:border-secondary-700"
                >
                  <button
                    type="button"
                    onClick={() => onSelectGroup(group.uuid || group.groupId)}
                    className={`w-full px-4 py-3 text-left transition-colors ${
                      selected
                        ? 'bg-bubble-sent/10 text-secondary-900 dark:bg-secondary-700 dark:text-secondary-50'
                        : 'text-secondary-700 hover:bg-secondary-50 dark:text-secondary-300 dark:hover:bg-secondary-700/50'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-medium">
                        {group.name}
                      </p>
                      {unread > 0 &&
                        (isPaidRequest ? (
                          <span className="shrink-0 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-semibold text-white">
                            PAID
                          </span>
                        ) : (
                          <span className="shrink-0 rounded-full bg-bubble-sent px-2 py-0.5 text-[10px] font-semibold text-white dark:bg-bubble-sent-dark">
                            {unread > 99 ? '99+' : unread}
                          </span>
                        ))}
                      <ChevronRight
                        className="h-4 w-4 shrink-0 text-secondary-400 dark:text-secondary-500"
                        strokeWidth={2}
                        aria-hidden
                      />
                    </div>
                    <p className="mt-0.5 font-mono text-[11px] text-secondary-400 dark:text-secondary-500">
                      {group.groupId.slice(0, 8)}...{group.groupId.slice(-6)}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
