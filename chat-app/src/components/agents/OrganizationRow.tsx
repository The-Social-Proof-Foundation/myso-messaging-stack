import {ChevronRight} from 'lucide-react';

interface OrganizationRowProps {
  name: string;
  detail: string;
  selected?: boolean;
  /** `card` matches the rounded member row in the chat info panel. */
  inset?: boolean;
  onClick: () => void;
}

/**
 * The organization list row: name, agent count, and a chevron.
 * The sidebar uses the full-bleed row. The info panel uses the inset card row.
 */
export function OrganizationRow({
  name,
  detail,
  selected = false,
  inset = false,
  onClick,
}: Readonly<OrganizationRowProps>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 text-left transition-colors ${
        inset
          ? 'px-3 py-2 hover:bg-secondary-200/80 dark:hover:bg-secondary-700'
          : `min-h-11 px-4 py-3 active:scale-[0.99] ${
              selected
                ? 'bg-secondary-100 dark:bg-secondary-800'
                : 'hover:bg-secondary-50 dark:hover:bg-secondary-700/50'
            }`
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-secondary-900 dark:text-secondary-50">
          {name}
        </span>
        <span className="mt-0.5 block truncate text-xs text-secondary-500 dark:text-secondary-400">
          {detail}
        </span>
      </span>
      <ChevronRight
        className="h-4 w-4 shrink-0 text-secondary-400 dark:text-secondary-500"
        strokeWidth={2}
        aria-hidden
      />
    </button>
  );
}
