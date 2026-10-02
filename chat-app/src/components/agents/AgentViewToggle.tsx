import {Boxes, ChevronRight} from 'lucide-react';

interface AgentViewToggleProps {
  onOpen: () => void;
}

/**
 * Entry point at the top of the home chat list that swaps the sidebar into organizations.
 */
export function AgentViewToggle({onOpen}: Readonly<AgentViewToggleProps>) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full shrink-0 items-center gap-2 border-b border-secondary-200 px-4 py-3 text-left transition-colors hover:bg-secondary-50 dark:border-secondary-700 dark:hover:bg-secondary-700/50"
    >
      <Boxes
        className="h-4 w-4 shrink-0 text-secondary-500 dark:text-secondary-400"
        strokeWidth={2}
        aria-hidden
      />
      <span className="min-w-0 flex-1 text-sm font-medium tracking-wide text-secondary-700 dark:text-secondary-200">
        Organizations
      </span>
      <ChevronRight
        className="h-4 w-4 shrink-0 text-secondary-400 dark:text-secondary-500"
        strokeWidth={2}
        aria-hidden
      />
    </button>
  );
}
