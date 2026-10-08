import type {ReactNode} from 'react';

/** Faint red notice for form and action errors: tinted fill, soft border, readable text in both themes. */
export function ErrorNotice({children, className = ''}: Readonly<{children: ReactNode; className?: string}>) {
  return (
    <p
      role="alert"
      className={`rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs leading-relaxed text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-300 ${className}`}
    >
      {children}
    </p>
  );
}
