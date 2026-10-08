import { useState, type ReactNode } from 'react';
import { AlertCircle, Check, ChevronDown, Loader2 } from 'lucide-react';
import type { PaymentRequestAction } from '@socialproof/myso-messaging-stack';
import { paymentPayloadNote } from '@socialproof/myso-messaging-stack';
import type { Message } from '../hooks/useMessages';
import { formatBaseUnits, transactionDetailsUrl } from '../lib/chat-payments';

const FAILURE_COPY: Record<string, string> = {
  chain_failed: 'The transaction failed on-chain.',
  sender_mismatch: 'The transaction was not sent by this account.',
  event_mismatch: 'The transaction did not transfer this token.',
  not_found: 'The transaction could not be found.',
  bad_metadata: 'The transfer details were invalid.',
};

interface PaymentMessageCardProps {
  message: Message;
  isOwnMessage: boolean;
  /** Display name of the other DM member. */
  peerLabel: string;
  /** Payer confirms an open request (submits the transfer). */
  onConfirm?: (message: Message) => Promise<void>;
  /** Payer rejects / requester cancels an open request. */
  onRespond?: (messageId: string, action: PaymentRequestAction) => Promise<void>;
  /** A payment action is in flight somewhere in this thread. */
  busy?: boolean;
}

function shortDigest(digest: string): string {
  return digest.length > 16 ? `${digest.slice(0, 8)}…${digest.slice(-6)}` : digest;
}

/**
 * Status widget for 1:1 DM payments. `token_transfer` shows Processing / Sent / Failed from the
 * relayer-confirmed status; `request_payment` shows the token, an optional description and
 * Reject / Confirm for the payer while open. Tap a transfer to see its transaction details.
 */
export function PaymentMessageCard({
  message,
  isOwnMessage,
  peerLabel,
  onConfirm,
  onRespond,
  busy = false,
}: Readonly<PaymentMessageCardProps>) {
  const [expanded, setExpanded] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState<PaymentRequestAction | 'confirm' | null>(null);

  const meta = message.paymentMetadata;
  const payload = message.payment;

  const surface = isOwnMessage
    ? 'bg-bubble-sent-fill text-white'
    : 'bg-bubble-received-fill text-secondary-900 dark:text-secondary-100';
  const subtle = isOwnMessage ? 'text-white/75' : 'text-secondary-500 dark:text-secondary-400';

  if (!meta || !payload) {
    return (
      <div className={`w-fit max-w-full rounded-[18px] px-3.5 py-2 text-[15px] ${surface}`}>
        Payment
      </div>
    );
  }

  const amount = `${formatBaseUnits(payload.amount, payload.asset.decimals)} ${payload.asset.symbol}`;
  const note = paymentPayloadNote(payload);

  async function run(kind: PaymentRequestAction | 'confirm', fn: () => Promise<void>) {
    setActing(kind);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setActing(null);
    }
  }

  const digest =
    meta.type === 'token_transfer' ? meta.digest : meta.fulfilledDigest;
  const detailsUrl = digest ? transactionDetailsUrl(digest) : null;

  let title: string;
  let statusNode: ReactNode = null;
  let actions: ReactNode = null;

  if (meta.type === 'token_transfer') {
    title = isOwnMessage ? `You sent ${peerLabel}` : `${peerLabel} sent you`;
    if (meta.status === 'pending') {
      statusNode = (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Processing
        </span>
      );
    } else if (meta.status === 'success') {
      statusNode = (
        <span className="inline-flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5" aria-hidden />
          {isOwnMessage ? 'Sent' : 'Received'}
        </span>
      );
    } else {
      statusNode = (
        <span className="inline-flex items-center gap-1.5">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden />
          Failed
        </span>
      );
    }
  } else {
    title = isOwnMessage ? `You requested from ${peerLabel}` : `${peerLabel} requested`;
    const canAct = !busy && acting === null;
    if (meta.status === 'open') {
      if (isOwnMessage) {
        statusNode = <span>Waiting for {peerLabel}</span>;
        if (onRespond) {
          actions = (
            <button
              type="button"
              disabled={!canAct}
              onClick={() => void run('cancel', () => onRespond(message.messageId, 'cancel'))}
              className="rounded-full px-3 py-1 text-xs font-medium text-white/90 hover:bg-white/15 disabled:opacity-50"
            >
              {acting === 'cancel' ? '…' : 'Cancel request'}
            </button>
          );
        }
      } else if (onConfirm && onRespond) {
        statusNode = <span>Pay {peerLabel}?</span>;
        actions = (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!canAct}
              onClick={() => void run('reject', () => onRespond(message.messageId, 'reject'))}
              className="flex-1 rounded-full border border-secondary-300 px-3 py-1.5 text-xs font-semibold text-secondary-700 hover:bg-secondary-100 disabled:opacity-50 dark:border-secondary-600 dark:text-secondary-200 dark:hover:bg-secondary-700"
            >
              {acting === 'reject' ? '…' : 'Reject'}
            </button>
            <button
              type="button"
              disabled={!canAct}
              onClick={() => void run('confirm', () => onConfirm(message))}
              className="flex-1 rounded-full bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-700 disabled:opacity-50"
            >
              {acting === 'confirm' ? 'Sending…' : 'Confirm'}
            </button>
          </div>
        );
      } else {
        statusNode = <span>Waiting for you</span>;
      }
    } else if (meta.status === 'paid') {
      statusNode = (
        <span className="inline-flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5" aria-hidden />
          Paid
        </span>
      );
    } else if (meta.status === 'rejected') {
      statusNode = <span>Declined</span>;
    } else if (meta.status === 'cancelled') {
      statusNode = <span>Cancelled</span>;
    } else {
      statusNode = <span>Expired</span>;
    }
  }

  const failureReason =
    meta.type === 'token_transfer' && meta.status === 'failed'
      ? (FAILURE_COPY[meta.reason ?? ''] ?? 'The transfer did not complete.')
      : null;
  const hasDetails = Boolean(digest);

  return (
    <div className={`w-[260px] max-w-full overflow-hidden rounded-[18px] shadow-sm dark:shadow-none ${surface}`}>
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((v) => !v)}
        aria-expanded={hasDetails ? expanded : undefined}
        className={`block w-full px-3.5 pb-2.5 pt-3 text-left ${hasDetails ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <p className={`text-xs ${subtle}`}>{title}</p>
        <p className="mt-0.5 text-[22px] font-semibold leading-tight">{amount}</p>
        {note ? <p className="mt-1 break-words text-[13px] leading-snug">{note}</p> : null}
        <div className={`mt-2 flex items-center justify-between text-xs ${subtle}`}>
          {statusNode}
          {hasDetails ? (
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
              aria-hidden
            />
          ) : null}
        </div>
        {failureReason ? <p className={`mt-1 text-xs ${subtle}`}>{failureReason}</p> : null}
      </button>

      {expanded && digest ? (
        <div className={`border-t px-3.5 py-2 text-xs ${isOwnMessage ? 'border-white/20' : 'border-secondary-200 dark:border-secondary-600'}`}>
          <p className={subtle}>Transaction</p>
          <p className="mt-0.5 flex items-center gap-2 font-mono">
            <span title={digest}>{shortDigest(digest)}</span>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(digest)}
              className="underline underline-offset-2"
            >
              Copy
            </button>
            {detailsUrl ? (
              <a href={detailsUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                View
              </a>
            ) : null}
          </p>
        </div>
      ) : null}

      {actions ? <div className="px-3.5 pb-3">{actions}</div> : null}
      {actionError ? (
        <p className="px-3.5 pb-3 text-xs text-danger-500" role="alert">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
