import {ReservationNavAvatar} from './ReservationNavAvatar';
import {AgentOrb} from './agents/AgentOrb';
import {thinkingLabel} from '../lib/agents/reply-status';

export interface Typer {
  address: string;
  label: string;
  /** Profile photo URL; falls back to default avatar when null/undefined. */
  avatarSrc?: string | null;
  /** SPT reservation ring (same as message bubbles). */
  showRing?: boolean;
  ringPercent?: number;
  /** Agent typer: orb instead of the empty photo, in the listening state. */
  orb?: boolean;
  /** What a working agent is doing ("Searching memory…"); shown instead of a typing bubble. */
  status?: string | null;
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

  const primary = typers[0]!;
  const status = primary.orb
    ? `${primary.label}: ${thinkingLabel(primary.status)}`
    : formatTypingStatus(typers);

  return (
    <div
      className={`flex min-w-0 max-w-full justify-start px-4 ${
        continueStack ? 'mt-0.5' : primary.orb ? 'mt-1.5' : 'mt-2.5'
      } ${primary.orb ? 'pb-4' : ''}`}
      aria-live="polite"
      aria-label={status}
    >
      <div
        className={`flex gap-0 ${
          primary.orb ? 'max-w-full items-start sm:max-w-[min(100%,46rem)]' : 'max-w-[85%] items-end sm:max-w-[75%]'
        }`}
      >
        <ReservationNavAvatar
          address={primary.address}
          imageSrc={primary.avatarSrc}
          face={
            primary.orb ? (
              <AgentOrb
                agentKey={primary.address}
                size={AVATAR_SIZE}
                label={primary.label}
                state="thinking"
              />
            ) : undefined
          }
          size={AVATAR_SIZE}
          showRing={primary.showRing}
          ringPercent={primary.ringPercent}
          className={`relative z-20 shrink-0 rounded-full shadow-sm dark:shadow-none ${
            primary.orb ? 'mt-0.5' : 'mb-0.5'
          }`}
        />

        <div
          className={`relative z-0 min-w-0 shrink ${primary.orb ? 'pl-2' : ''}`}
          style={primary.orb ? undefined : {marginLeft: -AVATAR_OVERLAP_PX}}
        >
          {primary.orb ? (
            // An agent shows who it is and what it is doing, laid out like its own messages.
            <div>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 leading-none">
                <span className="font-sans text-[11px] font-medium tracking-tight text-secondary-500 dark:text-secondary-400">
                  {primary.label}
                </span>
                <span className="rounded bg-secondary-200/80 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-secondary-600 dark:bg-secondary-600/80 dark:text-secondary-200">
                  Agent
                </span>
              </div>
              <p className="mt-0.5 animate-pulse text-[15px] italic leading-snug text-secondary-500 dark:text-secondary-400">
                {thinkingLabel(primary.status)}
              </p>
            </div>
          ) : (
            <>
              {/* Same height as a one-line message bubble, so the swap to the real message does not jump. */}
              <div className="bg-bubble-received-fill inline-flex min-h-[37px] max-w-full items-center overflow-hidden rounded-[18px] px-3.5 shadow-sm dark:shadow-none">
                <span className="inline-flex gap-1" aria-hidden="true">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-secondary-400 [animation-delay:0ms] dark:bg-secondary-300" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-secondary-400 [animation-delay:150ms] dark:bg-secondary-300" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-secondary-400 [animation-delay:300ms] dark:bg-secondary-300" />
                </span>
              </div>
              <p className="mt-1 pl-[14px] pr-3.5 text-[11px] text-secondary-400 dark:text-secondary-500">
                {status}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
