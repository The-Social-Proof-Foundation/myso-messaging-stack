export interface Typer {
  address: string;
  label: string;
}

interface TypingIndicatorProps {
  typers: Typer[];
}

/** Formats the typing status line for 1, 2, or many typers. */
export function formatTypingStatus(typers: Typer[]): string {
  if (typers.length === 0) return '';
  if (typers.length === 1) return `${typers[0]!.label} is typing…`;
  if (typers.length === 2) {
    return `${typers[0]!.label} and ${typers[1]!.label} are typing…`;
  }
  return `${typers[0]!.label} and ${typers.length - 1} others are typing…`;
}

/**
 * In-thread typing bubble — left-aligned like an incoming message.
 */
export function TypingIndicator({ typers }: Readonly<TypingIndicatorProps>) {
  if (typers.length === 0) return null;

  const status = formatTypingStatus(typers);

  return (
    <div
      className="flex min-w-0 max-w-full justify-start px-4 py-1"
      aria-live="polite"
      aria-label={status}
    >
      <div className="min-w-0 max-w-[70%] shrink">
        <div className="max-w-full overflow-hidden rounded-2xl bg-secondary-100 px-4 py-2.5 dark:bg-secondary-700">
          <div className="flex items-center gap-2">
            <span className="inline-flex gap-0.5" aria-hidden="true">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-secondary-400 [animation-delay:0ms] dark:bg-secondary-300" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-secondary-400 [animation-delay:150ms] dark:bg-secondary-300" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-secondary-400 [animation-delay:300ms] dark:bg-secondary-300" />
            </span>
            <span className="text-xs text-secondary-500 dark:text-secondary-300">
              {status}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
