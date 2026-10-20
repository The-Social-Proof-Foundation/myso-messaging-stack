import { useEffect, useRef, useState } from 'react';

const CHECK_PATH_LENGTH = 28;
const TEXT_SWAP_MS = 280;

function TextSwap({ text }: Readonly<{ text: string }>) {
  const ref = useRef<HTMLSpanElement>(null);
  const [displayText, setDisplayText] = useState(text);
  const prevTextRef = useRef(text);

  useEffect(() => {
    if (text === prevTextRef.current) return;
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplayText(text);
      prevTextRef.current = text;
      return;
    }
    el.classList.add('is-exit');
    const timer = window.setTimeout(() => {
      setDisplayText(text);
      el.classList.remove('is-exit');
      el.classList.add('is-enter-start');
      void el.offsetHeight;
      el.classList.remove('is-enter-start');
      prevTextRef.current = text;
    }, TEXT_SWAP_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  return (
    <span ref={ref} className="t-text-swap">
      {displayText}
    </span>
  );
}

function SuccessCheck({ size = 88 }: Readonly<{ size?: number }>) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.setAttribute('data-state', 'in');
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      el.setAttribute('data-state', 'in');
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <span
      ref={ref}
      className="t-success-check"
      data-state="out"
      aria-hidden="true"
      style={{ ['--check-path-length' as string]: `${CHECK_PATH_LENGTH}` }}
    >
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
        <circle cx="24" cy="24" r="22" className="fill-[#BFEF6A] dark:fill-[#D6F59A]" />
        <path
          d="M15 24.5L21.5 31L33 18"
          className="stroke-secondary-950"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function LoadingSpinner() {
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const arc = 0.35 * circumference;
  const gap = circumference - arc;

  return (
    <svg
      className="h-6 w-6 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r={radius}
        className="stroke-secondary-400"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity={0.25}
      />
      <g transform="translate(12 12)">
        <g
          className="animate-[spin_0.75s_linear_infinite]"
          style={{ transformOrigin: '0px 0px' }}
        >
          <circle
            cx="0"
            cy="0"
            r={radius}
            className="stroke-secondary-300"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${arc} ${gap}`}
          />
        </g>
      </g>
    </svg>
  );
}

/** Centered processing / success state from the wallet transaction overlay. */
export function TxStatusOverlay({
  phase,
  processingText = 'Processing transaction...',
  successText = 'Signed in',
  className = '',
  /** Cover only the dialog card. The parent panel must be `relative`. */
  contained = false,
}: Readonly<{
  phase: 'processing' | 'success';
  processingText?: string;
  successText?: string;
  className?: string;
  contained?: boolean;
}>) {
  const label = phase === 'success' ? successText : processingText;

  return (
    <div
      className={`${
        contained
          ? 'absolute inset-0 z-10 overflow-hidden rounded-[inherit]'
          : 'fixed inset-0 z-[60]'
      } flex items-center justify-center bg-white/75 backdrop-blur-sm dark:bg-secondary-950/80 ${className}`}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      {phase === 'success' ? (
        <div className="flex flex-col items-center">
          <SuccessCheck />
          <p className="mt-8 text-sm text-secondary-500 dark:text-secondary-400">
            {successText}
          </p>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-2 px-6">
          <LoadingSpinner />
          <p className="text-sm text-secondary-500 dark:text-secondary-400">
            <TextSwap text={processingText} />
          </p>
        </div>
      )}
    </div>
  );
}
