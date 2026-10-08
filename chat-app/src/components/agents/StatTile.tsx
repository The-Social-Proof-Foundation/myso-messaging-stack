import type {ReactNode} from 'react';

export const mysoUnitClass = 'font-chakra text-[10px] font-medium tracking-wide';

/** The bordered stat tile used in the organization header, shared so the drawer matches it. */
export function StatTile({label, value}: Readonly<{label: string; value: ReactNode}>) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-muted/70 py-1.5 pr-4 pl-2.5">
      <p className="text-[11px] text-secondary-500">{label}</p>
      <p className="truncate text-sm text-secondary-900 dark:text-secondary-50">{value}</p>
    </div>
  );
}
