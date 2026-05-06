interface GroupNameSectionProps {
  groupName: string;
  editingName: boolean;
  newName: string;
  renaming: boolean;
  onEditStart: () => void;
  onEditCancel: () => void;
  onNameChange: (name: string) => void;
  onRename: () => void;
}

export function GroupNameSection({
  groupName,
  editingName,
  newName,
  renaming,
  onEditStart,
  onEditCancel,
  onNameChange,
  onRename,
}: Readonly<GroupNameSectionProps>) {
  return (
    <section className="border-b border-secondary-100 p-4 dark:border-secondary-700">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-secondary-500 dark:text-secondary-400">
        Group Name
      </h4>
      {editingName ? (
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRename();
              if (e.key === 'Escape') onEditCancel();
            }}
            disabled={renaming}
            className="flex-1 rounded-lg border border-secondary-300 bg-white px-2 py-1 text-xs text-secondary-900 focus:border-primary-500 focus:outline-none disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-700 dark:text-secondary-100"
            autoFocus
          />
          <button
            onClick={onRename}
            disabled={renaming}
            className="text-xs text-primary-500 hover:text-primary-600 disabled:opacity-50"
          >
            {renaming ? '...' : 'Save'}
          </button>
        </div>
      ) : (
        <button
          onClick={onEditStart}
          className="text-left text-xs text-secondary-700 hover:text-primary-500 dark:text-secondary-300"
        >
          {groupName} <span className="text-secondary-400">✎</span>
        </button>
      )}
    </section>
  );
}
