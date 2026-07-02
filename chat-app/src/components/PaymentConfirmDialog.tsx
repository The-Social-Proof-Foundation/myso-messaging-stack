/**
 * Confirmation dialog for paid messaging: the recipient requires an on-chain
 * MYSO escrow before accepting a first message from a non-follower.
 *
 * Purely presentational — the caller runs the payment transaction on confirm
 * (openPaidDm for new DMs, payDmEscrow for existing groups) and retries the
 * send once the relayer indexes the escrow.
 */
import { mistToMyso } from '../lib/mys-coin';

interface PaymentConfirmDialogProps {
  open: boolean;
  /** Recipient wallet that requires payment. */
  recipient: string | null;
  /** Required escrow in MIST (from the relayer's paid-DM gate). */
  minCost: bigint | null;
  /** Payment transaction in flight. */
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function PaymentConfirmDialog({
  open,
  recipient,
  minCost,
  busy,
  error,
  onConfirm,
  onCancel,
}: Readonly<PaymentConfirmDialogProps>) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl dark:bg-secondary-800">
        <h3 className="mb-2 text-base font-semibold text-secondary-900 dark:text-secondary-100">
          Payment Required
        </h3>

        <p className="mb-3 text-sm text-secondary-600 dark:text-secondary-400">
          <span className="font-medium">
            {recipient ? truncateAddress(recipient) : 'This user'}
          </span>{' '}
          has paid messaging enabled. Sending your first message requires an
          on-chain escrow of{' '}
          <span className="font-semibold text-secondary-900 dark:text-secondary-100">
            {minCost !== null ? mistToMyso(minCost) : '—'} MYSO
          </span>
          .
        </p>

        <p className="mb-4 text-xs text-secondary-500 dark:text-secondary-500">
          The recipient claims the escrow by replying. If they never reply, you
          can refund it after 30 days.
        </p>

        {error && <p className="mb-3 text-sm text-danger-500">{error}</p>}

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm font-medium text-secondary-600 hover:bg-secondary-100 disabled:opacity-50 dark:text-secondary-400 dark:hover:bg-secondary-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || minCost === null}
            className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600 disabled:opacity-50"
          >
            {busy ? 'Paying…' : 'Confirm & Pay'}
          </button>
        </div>
      </div>
    </div>
  );
}
