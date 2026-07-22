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
   * When true, this indicator continues the last incoming sender’s pack:
   * tight stack gap, avatar + status as the pack tip (no second “new” pack).
   * When false, it starts a new turn with normal spacing.
   */
  continueStack?: boolean;
}

const AVATAR_SIZE = 28;
const AVATAR_OVERLAP_PX = 14;
/** Match MessageBubble mid-stack spacer when the tip avatar is on a prior row. */
const AVATAR_COLUMN_INSET = AVATAR_SIZE - AVATAR_OVERLAP_PX;

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
  // Continuing a pack: the previous bubble already had the avatar — only show
  // dots in-stack. New turn (different user): avatar + name meta.
  const showAvatar = !continueStack;

  return (
    <div
      className={`flex min-w-0 max-w-full justify-start px-4 ${
        continueStack ? 'mt-0.5' : 'mt-2.5'
      }`}
      aria-live="polite"
      aria-label={status}
    >
      <div className="flex max-w-[85%] items-end gap-0 sm:max-w-[75%]">
        {showAvatar ? (
          <ReservationNavAvatar
            address={primary.address}
            imageSrc={primary.avatarSrc}
            size={AVATAR_SIZE}
            showRing={primary.showRing}
            ringPercent={primary.ringPercent}
            className="relative z-20 mb-0.5 shrink-0 rounded-full shadow-sm dark:shadow-none"
          />
        ) : (
          <span
            className="shrink-0"
            style={{width: AVATAR_COLUMN_INSET, height: AVATAR_SIZE}}
            aria-hidden
          />
        )}

        <div
          className="relative z-0 min-w-0 shrink"
          style={showAvatar ? {marginLeft: -AVATAR_OVERLAP_PX} : undefined}
        >
          <div className="bg-bubble-received-fill inline-flex max-w-full overflow-hidden rounded-[18px] px-3.5 py-2.5 shadow-sm dark:shadow-none">
            <span className="inline-flex gap-1" aria-hidden="true">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-secondary-400 [animation-delay:0ms] dark:bg-secondary-300" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-secondary-400 [animation-delay:150ms] dark:bg-secondary-300" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-secondary-400 [animation-delay:300ms] dark:bg-secondary-300" />
            </span>
          </div>
          {/* New turn: name under the bubble. Same-stack: no second meta line —
              the pack tip chrome stays on the last real message. */}
          {!continueStack ? (
            <p className="mt-1 pl-[14px] pr-3.5 text-[11px] text-secondary-400 dark:text-secondary-500">
              {status}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
