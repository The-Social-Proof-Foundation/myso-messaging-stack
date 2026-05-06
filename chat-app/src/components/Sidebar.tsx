import type { StoredGroup } from '../lib/group-store';

interface SidebarProps {
  groups: StoredGroup[];
  selectedUuid: string | null;
  onSelectGroup: (uuid: string) => void;
  onCreateGroup: () => void;
  loading?: boolean;
}

export function Sidebar({
  groups,
  selectedUuid,
  onSelectGroup,
  onCreateGroup,
  loading = false,
}: Readonly<SidebarProps>) {
  return (
    <aside className="flex w-72 flex-col border-r border-secondary-200 bg-white dark:border-secondary-700 dark:bg-secondary-800">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-secondary-200 px-4 py-3 dark:border-secondary-700">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-secondary-700 dark:text-secondary-300">
            Groups
          </h2>
          {loading && (
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
          )}
        </div>
        <button
          onClick={onCreateGroup}
          className="rounded-lg bg-primary-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-600"
        >
          + New
        </button>
      </div>

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
          <ul className="py-1">
            {groups.map((group) => (
              <li key={group.uuid || group.groupId}>
                <button
                  onClick={() => onSelectGroup(group.uuid || group.groupId)}
                  className={`w-full px-4 py-3 text-left transition-colors ${
                    (selectedUuid === group.uuid ||
                      selectedUuid === group.groupId) &&
                    selectedUuid
                      ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
                      : 'text-secondary-700 hover:bg-secondary-50 dark:text-secondary-300 dark:hover:bg-secondary-700/50'
                  }`}
                >
                  <p className="text-sm font-medium truncate">{group.name}</p>
                  <p className="mt-0.5 text-xs text-secondary-400 font-mono dark:text-secondary-500">
                    {group.groupId.slice(0, 8)}...{group.groupId.slice(-6)}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
