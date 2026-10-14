/**
 * When and how fast an agent's reply types itself out.
 *
 * It only plays for a reply that has just arrived, once. History, scrolling back, reopening a chat
 * and a message remounting must never replay it, and a reader who asks for less motion gets the
 * reply at once.
 */

/** Characters revealed per second. Quick, like fast typing, not like a slow teletype. */
export const REVEAL_CHARS_PER_SECOND = 450;
export const REVEAL_MIN_MS = 600;
/** However long the reply, the reveal never makes the reader wait longer than this. */
export const REVEAL_MAX_MS = 4000;
/** A reply older than this was not "just typed": it came with the history. */
export const REVEAL_FRESH_MS = 15_000;
/** Clock drift between the relayer and this device that is still treated as "now". */
const CLOCK_SKEW_MS = 5 * 60_000;

export function revealDurationMs(visibleChars: number): number {
  const natural = (Math.max(0, visibleChars) / REVEAL_CHARS_PER_SECOND) * 1000;
  return Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, natural));
}

/** Characters shown `elapsedMs` into a reveal of `total` characters over `durationMs`. */
export function revealedCount(total: number, elapsedMs: number, durationMs: number): number {
  if (total <= 0 || durationMs <= 0 || elapsedMs >= durationMs) return Math.max(0, total);
  return Math.max(0, Math.min(total, Math.floor((elapsedMs / durationMs) * total)));
}

/** Messages that have been shown, so a remount never replays one. Lives for the page's lifetime. */
const shown = new Set<string>();

export function markRevealShown(messageId: string): void {
  shown.add(messageId);
}

export function hasRevealBeenShown(messageId: string): boolean {
  return shown.has(messageId);
}

/** Reset between tests. */
export function resetRevealRegistry(): void {
  shown.clear();
}

export interface RevealCheck {
  messageId: string;
  /** When the reply was sent, in milliseconds. */
  createdAt: number | null | undefined;
  now?: number;
  reducedMotion: boolean;
  /** Edited and deleted messages are shown as they are. */
  edited?: boolean;
}

/** Whether this reply should type itself out when it first appears. Pure: it marks nothing. */
export function shouldReveal(check: RevealCheck): boolean {
  if (check.reducedMotion || check.edited) return false;
  if (hasRevealBeenShown(check.messageId)) return false;
  if (!check.createdAt || !Number.isFinite(check.createdAt)) return false;
  const age = (check.now ?? Date.now()) - check.createdAt;
  return age <= REVEAL_FRESH_MS && age >= -CLOCK_SKEW_MS;
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
