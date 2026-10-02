import {useEffect, type KeyboardEvent, type ReactNode} from 'react';
import {X} from 'lucide-react';

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Rendered as a right-aligned action row below the body. */
  footer?: ReactNode;
  /** Blocks backdrop/escape dismissal while a transaction is in flight. */
  busy?: boolean;
  maxWidthClass?: string;
}

/**
 * Modal chrome shared by every create/manage dialog, matching the New Message dialog's
 * overlay, panel, title treatment, and close affordance.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  busy = false,
  maxWidthClass = 'max-w-md',
}: Readonly<DialogProps>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const titleId = `dialog-title-${title.replace(/\W+/g, '-').toLowerCase()}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (!busy) onClose();
      }}
      role="presentation"
    >
      <div
        className={`max-h-[90vh] w-full ${maxWidthClass} overflow-y-auto rounded-xl bg-white p-6 shadow-2xl dark:bg-secondary-800`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="relative mb-4 flex items-center justify-center">
          <h2
            id={titleId}
            className="font-chakra text-lg font-semibold tracking-wide text-secondary-900 dark:text-secondary-100"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="absolute right-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-secondary-500 hover:bg-secondary-100 hover:text-secondary-800 disabled:opacity-50 dark:text-secondary-400 dark:hover:bg-secondary-700 dark:hover:text-secondary-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {children}

        {footer ? (
          <div className="mt-5 flex items-center justify-end gap-2">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

/** Shared input styling used inside dialogs. */
export const dialogFieldClass =
  'w-full rounded-lg border border-secondary-300 bg-white px-3 py-2 text-sm text-secondary-900 placeholder:text-secondary-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-700 dark:text-secondary-100 dark:placeholder:text-secondary-500';

export const dialogPrimaryButtonClass =
  'inline-flex items-center justify-center rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:opacity-50';

export const dialogSecondaryButtonClass =
  'inline-flex items-center justify-center rounded-lg border border-secondary-300 px-4 py-2 text-sm font-medium text-secondary-700 transition-colors hover:bg-secondary-100 disabled:opacity-50 dark:border-secondary-600 dark:text-secondary-200 dark:hover:bg-secondary-700';
