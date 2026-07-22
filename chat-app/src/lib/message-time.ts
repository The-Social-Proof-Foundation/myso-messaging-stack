/**
 * Chat thread timestamps — aligned with iOS ChatThreadViewController
 * (middle time markers, bubble meta, Beginning of Chat).
 */

/** Insert an extra mid-thread time marker every N messages in a <24h streak. */
export const MESSAGE_TIME_MARKER_EVERY = 25;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Normalize store/API timestamps: ms if > 1e12, else unix seconds → Date. */
export function toDate(epoch: number): Date {
  if (!Number.isFinite(epoch) || epoch <= 0) return new Date();
  return new Date(epoch > 1_000_000_000_000 ? epoch : epoch * 1000);
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Base day label: Today / Yesterday / long date (no clock). */
export function formatDayLabel(epochSeconds: number): string {
  const date = toDate(epochSeconds);
  const today = startOfLocalDay(new Date());
  const target = startOfLocalDay(date);
  const deltaDays = Math.round((today.getTime() - target.getTime()) / DAY_MS);
  if (deltaDays === 0) return 'Today';
  if (deltaDays === 1) return 'Yesterday';
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatClock(epochSeconds: number): string {
  return toDate(epochSeconds).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Centered middle timestamp.
 * Density markers (`includeTime`) render like `Today, at 3:45 PM`.
 */
export function formatDaySeparator(
  epochSeconds: number,
  opts?: { includeTime?: boolean },
): string {
  const base = formatDayLabel(epochSeconds);
  if (opts?.includeTime) {
    return `${base}, at ${formatClock(epochSeconds)}`;
  }
  return base;
}

export type TimeMarkerInfo = {
  /** True when this marker was inserted for message density (not a 24h gap). */
  includeTime: boolean;
};

/**
 * Compute middle timestamps for an ascending (oldest→newest) message list.
 * A marker is shown *before* the message id in the map.
 *
 * - Gap ≥ 24h from the previous message → date label (Today / Yesterday / …)
 * - Else every {@link MESSAGE_TIME_MARKER_EVERY} messages in the streak →
 *   same label with `, at h:mm a`
 */
export function computeTimeMarkers(
  messages: ReadonlyArray<{ messageId: string; createdAt: number }>,
): Map<string, TimeMarkerInfo> {
  const markers = new Map<string, TimeMarkerInfo>();
  if (messages.length === 0) return markers;

  let segmentStartIndex = 0;
  for (let i = 1; i < messages.length; i++) {
    const prev = toDate(messages[i - 1]!.createdAt).getTime();
    const cur = toDate(messages[i]!.createdAt).getTime();
    if (cur - prev >= DAY_MS) {
      markers.set(messages[i]!.messageId, { includeTime: false });
      segmentStartIndex = i;
    } else if (i - segmentStartIndex >= MESSAGE_TIME_MARKER_EVERY) {
      markers.set(messages[i]!.messageId, { includeTime: true });
      segmentStartIndex = i;
    }
  }
  return markers;
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
