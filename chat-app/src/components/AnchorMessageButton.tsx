import {useEffect, useRef, useState, type ReactNode} from 'react';
import {CheckCircle2, ShieldCheck} from 'lucide-react';

import type {AnchoredInfo} from '../lib/agents/anchor';
import {copyText} from './CopyTextButton';
import {HoverTip} from './HoverTip';

interface AnchorMessageButtonProps {
  /** Present once the indexer reports this message's digest. */
  anchored?: AnchoredInfo;
  onAnchor?: () => Promise<unknown>;
}

const abbreviate = (value: string) => (value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value);

/**
 * The small shield beside a message: click to anchor it on-chain, then green once anchored.
 * A green shield copies its transaction digest. Every state explains itself in a hover popup, and
 * an anchored one shows the same `#seq hash` the Verify list shows, so the two read as one record.
 */
export function AnchorMessageButton({anchored, onAnchor}: Readonly<AnchorMessageButtonProps>) {
  const [busy, setBusy] = useState(false);
  // Between the transaction landing and the indexer reporting it, the shield stays green.
  const [justAnchored, setJustAnchored] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);
  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const isAnchored = Boolean(anchored) || justAnchored;

  let tip: ReactNode;
  if (error) tip = error;
  else if (busy) tip = 'Anchoring on-chain…';
  else if (anchored) {
    tip = copied ? (
      <span className="flex items-center gap-1.5 font-medium text-emerald-300">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
        Copied
      </span>
    ) : (
      <div className="w-56 space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 font-medium text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            Anchored on-chain
          </span>
          <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-secondary-200">
            #{anchored.seq}
          </span>
        </div>
        <dl className="space-y-2">
          <div>
            <dt className="text-[10.5px] uppercase tracking-wide text-secondary-400">Digest</dt>
            <dd className="mt-0.5 font-mono text-[11.5px] tracking-tight text-secondary-100">
              {abbreviate(anchored.contentDigest)}
            </dd>
          </div>
          <div>
            <dt className="text-[10.5px] uppercase tracking-wide text-secondary-400">Transaction</dt>
            <dd className="mt-0.5 font-mono text-[11.5px] tracking-tight text-secondary-100">
              {abbreviate(anchored.transactionId)}
            </dd>
          </div>
        </dl>
      </div>
    );
  } else if (justAnchored) tip = 'Anchored on-chain. Waiting for the indexer to list it…';
  else {
    tip = (
      <div className="w-56 space-y-1">
        <span className="block font-medium text-secondary-50">Anchor on-chain</span>
        <span className="block text-[11.5px] leading-relaxed text-secondary-300">
          Click to publish this message's fingerprint so anyone can verify it was never changed. The
          text stays private.
        </span>
      </div>
    );
  }

  const disabled = busy || (!onAnchor && !anchored);

  return (
    <HoverTip content={tip}>
      <button
        type="button"
        aria-label={typeof tip === 'string' ? tip : isAnchored ? 'Anchored on-chain' : 'Anchor on-chain'}
        disabled={disabled}
        onClick={async (event) => {
          event.stopPropagation();
          if (anchored) {
            if (await copyText(anchored.transactionId)) {
              setCopied(true);
              later(() => setCopied(false), 1500);
            }
            return;
          }
          if (isAnchored || !onAnchor) return;
          setBusy(true);
          setError(null);
          try {
            await onAnchor();
            setJustAnchored(true);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not anchor this message.');
            later(() => setError(null), 6000);
          } finally {
            setBusy(false);
          }
        }}
        className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded align-middle leading-none transition-colors ${
          error
            ? 'text-danger-500'
            : isAnchored
              ? 'text-emerald-500 hover:text-emerald-400 dark:text-emerald-400'
              : 'text-secondary-400/70 hover:text-secondary-600 dark:text-secondary-500/70 dark:hover:text-secondary-300'
        } ${busy ? 'animate-pulse' : ''} disabled:cursor-default`}
      >
        <ShieldCheck className="h-2.5 w-2.5" aria-hidden />
      </button>
    </HoverTip>
  );
}
