interface PermType {
  key: string;
  value: string;
}

interface AddMemberFormProps {
  newAddress: string;
  selectedPerms: string[];
  adding: boolean;
  addError: string | null;
  messagingPermTypes: PermType[];
  onAddressChange: (address: string) => void;
  onTogglePerm: (permValue: string) => void;
  onSelectAllPerms: () => void;
  onSubmit: (e: React.SyntheticEvent) => void;
}

export function AddMemberForm({
  newAddress,
  selectedPerms,
  adding,
  addError,
  messagingPermTypes,
  onAddressChange,
  onTogglePerm,
  onSelectAllPerms,
  onSubmit,
}: Readonly<AddMemberFormProps>) {
  return (
    <section className="border-b border-secondary-100 p-4 dark:border-secondary-700">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-secondary-500 dark:text-secondary-400">
        Add Member
      </h4>

      <form onSubmit={onSubmit} className="space-y-3">
        <input
          type="text"
          value={newAddress}
          onChange={(e) => onAddressChange(e.target.value)}
          placeholder="MySo address (0x...)"
          disabled={adding}
          className="w-full rounded-lg border border-secondary-300 bg-white px-3 py-1.5 text-xs text-secondary-900 placeholder:text-secondary-400 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500/20 disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-700 dark:text-secondary-100"
        />

        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs text-secondary-600 dark:text-secondary-400">
            <input
              type="checkbox"
              checked={selectedPerms.length === messagingPermTypes.length}
              onChange={onSelectAllPerms}
              disabled={adding}
              className="rounded"
            />
            <span className="font-medium">Select All</span>
          </label>
          {messagingPermTypes.map((perm) => (
            <label
              key={perm.key}
              className="flex items-center gap-2 text-xs text-secondary-600 dark:text-secondary-400"
            >
              <input
                type="checkbox"
                checked={selectedPerms.includes(perm.value)}
                onChange={() => onTogglePerm(perm.value)}
                disabled={adding}
                className="rounded"
              />
              {perm.key}
            </label>
          ))}
        </div>

        {addError && <p className="text-xs text-danger-500">{addError}</p>}

        <button
          type="submit"
          disabled={adding}
          className="w-full rounded-lg bg-primary-500 py-1.5 text-xs font-medium text-white hover:bg-primary-600 disabled:opacity-50"
        >
          {adding ? 'Adding...' : 'Add Member'}
        </button>
      </form>
    </section>
  );
}
