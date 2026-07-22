/**
 * Chat thread timestamps — aligned with iOS ChatThreadViewController
 * (day separators, bubble meta, Beginning of Chat).
 */

/** Normalize store/API timestamps: ms if > 1e12, else unix seconds → Date. */
export function toDate(epoch: number): Date {
  if (!Number.isFinite(epoch) || epoch <= 0) return new Date();
  return new Date(epoch > 1_000_000_000_000 ? epoch : epoch * 1000);
}

export function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Centered day label: Today / Yesterday / long date (iOS relative long). */
export function formatDaySeparator(epochSeconds: number): string {
  const date = toDate(epochSeconds);
  const today = startOfLocalDay(new Date());
  const target = startOfLocalDay(date);
  const dayMs = 24 * 60 * 60 * 1000;
  const deltaDays = Math.round((today.getTime() - target.getTime()) / dayMs);
  if (deltaDays === 0) return 'Today';
  if (deltaDays === 1) return 'Yesterday';
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Bubble footer time. Relative under 24h; if older, own messages get
 * `MMM d, h:mm a`, incoming omit (`null`) unless `always`.
 */
export function formatMessageTime(
  epochSeconds: number,
  opts: { always: boolean },
): string | null {
  const date = toDate(epochSeconds);
  const diffMin = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${Math.max(diffMin, 1)}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  if (!opts.always) return null;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function dayOrdinal(day: number): string {
  const n = day % 100;
  if (n >= 11 && n <= 13) return 'th';
  switch (day % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

/** e.g. "July 20th, 2026 at 12:26 AM" */
export function formatBeginningCreated(epoch: number): string {
  const date = toDate(epoch);
  const day = date.getDate();
  const month = date.toLocaleDateString('en-US', { month: 'long' });
  const year = date.getFullYear();
  const time = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${month} ${day}${dayOrdinal(day)}, ${year} at ${time}`;
}
