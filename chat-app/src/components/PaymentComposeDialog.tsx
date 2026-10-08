/**
 * Compose dialog for 1:1 DM payments: send MYSO now, or request MYSO from the peer.
 * Purely presentational — the caller submits (`useMessages().sendTokenTransfer` /
 * `sendPaymentRequest`) and reports errors via `error`.
 */
import { useEffect, useState } from 'react';
import { mysoToMist } from '../lib/mys-coin';

export type PaymentComposeMode = 'send' | 'request';

interface PaymentComposeDialogProps {
  mode: PaymentComposeMode | null;
  /** Display name of the DM peer. */
  peerLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (input: { amountMist: bigint; note: string }) => Promise<void>;
  onClose: () => void;
}

export function PaymentComposeDialog({
  mode,
  peerLabel,
  busy,
  error,
  onSubmit,
  onClose,
}: Readonly<PaymentComposeDialogProps>) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (mode) {
      setAmount('');
      setNote('');
      setLocalError(null);
    }
  }, [mode]);

  if (!mode) return null;

  const isSend = mode === 'send';

  async function submit() {
    let amountMist: bigint;
    try {
      amountMist = mysoToMist(amount);
    } catch {
      setLocalError('Enter a valid MYSO amount (up to 9 decimals).');
      return;
    }
    if (amountMist <= 0n) {
      setLocalError('Enter an amount greater than zero.');
      return;
    }
    setLocalError(null);
    try {
      await onSubmit({ amountMist, note });
      onClose();
    } catch {
      // Hook sets `error`; keep the dialog open so the user can retry.
    }
  }

  const shownError = localError ?? error;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl dark:bg-secondary-800">
        <h3 className="mb-1 text-base font-semibold text-secondary-900 dark:text-secondary-100">
          {isSend ? `Send MYSO to ${peerLabel}` : `Request MYSO from ${peerLabel}`}
        </h3>
        <p className="mb-4 text-xs text-secondary-500">
          {isSend
            ? 'The transfer is sent from your wallet now. This chat shows its status.'
            : `${peerLabel} can confirm to pay you, or reject the request.`}
        </p>

        <label className="mb-1 block text-xs font-medium text-secondary-600 dark:text-secondary-400">
          Amount (MYSO)
        </label>
        <input
          autoFocus
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          disabled={busy}
          className="mb-3 w-full rounded-lg border border-secondary-300 bg-white px-3 py-2 text-lg text-secondary-900 focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-900 dark:text-secondary-100"
        />

        <label className="mb-1 block text-xs font-medium text-secondary-600 dark:text-secondary-400">
          {isSend ? 'Note (optional)' : 'Description (optional)'}
        </label>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={140}
          disabled={busy}
          className="mb-4 w-full rounded-lg border border-secondary-300 bg-white px-3 py-2 text-sm text-secondary-900 focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-900 dark:text-secondary-100"
        />

        {shownError && <p className="mb-3 text-sm text-danger-500">{shownError}</p>}

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm font-medium text-secondary-600 hover:bg-secondary-100 disabled:opacity-50 dark:text-secondary-400 dark:hover:bg-secondary-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !amount.trim()}
            className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600 disabled:opacity-50"
          >
            {busy ? (isSend ? 'Sending…' : 'Requesting…') : isSend ? 'Send' : 'Request'}
          </button>
        </div>
      </div>
    </div>
  );
}
