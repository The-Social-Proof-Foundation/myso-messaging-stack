import { useEffect, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { AddMemberForm } from './AddMemberForm';

interface PermType {
  key: string;
  value: string;
}

interface AddMemberDialogProps {
  open: boolean;
  onClose: () => void;
  newAddress: string;
  selectedPerms: string[];
  adding: boolean;
  addError: string | null;
  messagingPermTypes: PermType[];
  /** Wallets already in the group (excluded from search results). */
  existingMemberAddresses?: readonly string[];
  onAddressChange: (address: string) => void;
  onPermsChange: (permValues: string[]) => void;
  onSubmit: (e: React.SyntheticEvent) => void;
  /** When true, parent should refuse submit. */
  onBlockedChange?: (blocked: boolean) => void;
}

/**
 * Add Member modal — same shell as CreateGroupModal (backdrop, Escape, X).
 * Unmounting on close resets the picker, so each open starts clean.
 * Portaled to <body>: the admin panel rail is overflow-hidden and width-tweened,
 * which would otherwise clip / mis-anchor the fixed backdrop.
 */
export function AddMemberDialog({
  open,
  onClose,
  adding,
  ...formProps
}: Readonly<AddMemberDialogProps>) {
  // Escape to dismiss — ignored while the add is in flight.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !adding) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, adding, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (!adding) onClose();
      }}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl dark:bg-secondary-800"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-member-title"
      >
        <div className="relative mb-4 flex items-center justify-center">
          <h2
            id="add-member-title"
            className="font-chakra text-lg font-semibold tracking-wide text-secondary-900 dark:text-secondary-100"
          >
            Add Member
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={adding}
            aria-label="Close"
            className="absolute right-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-secondary-500 hover:bg-secondary-100 hover:text-secondary-800 disabled:opacity-50 dark:text-secondary-400 dark:hover:bg-secondary-700 dark:hover:text-secondary-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <AddMemberForm {...formProps} adding={adding} />
      </div>
    </div>,
    document.body,
  );
}
