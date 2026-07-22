import {ReservationNavAvatar} from './ReservationNavAvatar';

export interface Typer {
  address: string;
  label: string;
  /** Profile photo URL; falls back to default avatar when null/undefined. */
  avatarSrc?: string | null;
  /** SPT reservation ring (same as message bubbles). */
  showRing?: boolean;
  ringPercent?: number;
}

interface TypingIndicatorProps {
  typers: Typer[];
  /**
   * When true, continues the tip peer’s pack (tight stack gap).
   * When false, starts a new turn with normal spacing.
   * Avatar + status always sit under the dots (iOS pack-tip parity).
   */
  continueStack?: boolean;
}

const AVATAR_SIZE = 28;
const AVATAR_OVERLAP_PX = 14;

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
 * Same-sender pack: joins the stack as the tip (avatar + status once).
 * New turn: full avatar + username pack like a fresh incoming bubble.
 */
export function TypingIndicator({
  typers,
  continueStack = false,
}: Readonly<TypingIndicatorProps>) {
  if (typers.length === 0) return null;

  const status = formatTypingStatus(typers);
  const primary = typers[0]!;

  return (
    <div
      className={`flex min-w-0 max-w-full justify-start px-4 ${
        continueStack ? 'mt-0.5' : 'mt-2.5'
      }`}
      aria-live="polite"
      aria-label={status}
    >
      <div className="flex max-w-[85%] items-end gap-0 sm:max-w-[75%]">
        <ReservationNavAvatar
          address={primary.address}
          imageSrc={primary.avatarSrc}
          size={AVATAR_SIZE}
          showRing={primary.showRing}
          ringPercent={primary.ringPercent}
          className="relative z-20 mb-0.5 shrink-0 rounded-full shadow-sm dark:shadow-none"
        />

        <div
          className="relative z-0 min-w-0 shrink"
          style={{marginLeft: -AVATAR_OVERLAP_PX}}
        >
          <div className="bg-bubble-received-fill inline-flex max-w-full overflow-hidden rounded-[18px] px-3.5 py-2.5 shadow-sm dark:shadow-none">
            <span className="inline-flex gap-1" aria-hidden="true">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-secondary-400 [animation-delay:0ms] dark:bg-secondary-300" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-secondary-400 [animation-delay:150ms] dark:bg-secondary-300" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-secondary-400 [animation-delay:300ms] dark:bg-secondary-300" />
            </span>
          </div>
          <p className="mt-1 pl-[14px] pr-3.5 text-[11px] text-secondary-400 dark:text-secondary-500">
            {status}
          </p>
        </div>
      </div>
    </div>
  );
}
