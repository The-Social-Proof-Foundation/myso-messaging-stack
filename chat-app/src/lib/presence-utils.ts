import type { GroupPresenceEntry } from '@socialproof/myso-messaging-stack';

/** WS updates within this window are not overwritten by snapshot reconciliation. */
export const PRESENCE_WS_FRESH_MS = 15_000;

export type PresenceSource = 'ws' | 'snapshot';

export interface PresenceRecord {
  online: boolean;
  updatedAt: number;
  source: PresenceSource;
  /** Last known activity (ms epoch) from relayer `last_seen` or live events. */
  lastSeenAt?: number;
}

/** Trust the API online bit; lastSeen is display-only via lastSeenAt. */
export function deriveOnlineFromSnapshot(entry: GroupPresenceEntry): boolean {
  return entry.online;
}

function parseLastSeenMs(raw?: string): number | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function normalizeMemberKey(member: string): string {
  return member.toLowerCase();
}

/** Merge a presence update; WS events always win over snapshot for that member. */
export function mergePresenceRecord(
  prev: PresenceRecord | undefined,
  online: boolean,
  source: PresenceSource,
  lastSeenAt?: number,
): PresenceRecord {
  const now = Date.now();
  if (source === 'ws') {
    return {
      online,
      updatedAt: now,
      source: 'ws',
      lastSeenAt: online ? now : (lastSeenAt ?? prev?.lastSeenAt ?? now),
    };
  }

  // Explicit WS offline — never resurrect via snapshot until a new WS online.
  if (prev?.source === 'ws' && !prev.online) {
    return {
      ...prev,
      lastSeenAt: lastSeenAt ?? prev.lastSeenAt,
    };
  }

  // Fresh WS online — don't clobber with a stale snapshot.
  if (
    prev?.source === 'ws' &&
    prev.online &&
    now - prev.updatedAt < PRESENCE_WS_FRESH_MS
  ) {
    return {
      ...prev,
      lastSeenAt: lastSeenAt ?? prev.lastSeenAt,
    };
  }

  return {
    online,
    updatedAt: now,
    source: 'snapshot',
    lastSeenAt: lastSeenAt ?? prev?.lastSeenAt,
  };
}

export function applySnapshotEntries(
  prev: Map<string, PresenceRecord>,
  entries: GroupPresenceEntry[],
): Map<string, PresenceRecord> {
  const next = new Map(prev);
  for (const entry of entries) {
    const key = normalizeMemberKey(entry.member);
    const online = deriveOnlineFromSnapshot(entry);
    const lastSeenAt = parseLastSeenMs(entry.lastSeen);
    next.set(
      key,
      mergePresenceRecord(next.get(key), online, 'snapshot', lastSeenAt),
    );
  }
  return next;
}

export function applyWsPresence(
  prev: Map<string, PresenceRecord>,
  member: string,
  online: boolean,
): Map<string, PresenceRecord> {
  const next = new Map(prev);
  const key = normalizeMemberKey(member);
  next.set(key, mergePresenceRecord(next.get(key), online, 'ws'));
  return next;
}

export function presenceRecordsToOnlineMap(
  records: Map<string, PresenceRecord>,
): Map<string, boolean> {
  const online = new Map<string, boolean>();
  for (const [member, record] of records) {
    online.set(member, record.online);
  }
  return online;
}

/** Case-insensitive presence lookup (wallet keys stored lowercase). */
export function findPresenceRecord(
  records: Map<string, PresenceRecord>,
  address: string | null | undefined,
): PresenceRecord | undefined {
  if (!address) return undefined;
  return records.get(normalizeMemberKey(address));
}

/** Relative / calendar label for a last-seen timestamp (ms). */
export function formatLastOnlineAt(lastSeenAtMs: number, now = Date.now()): string {
  const diffMs = Math.max(0, now - lastSeenAtMs);
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;

  const date = new Date(lastSeenAtMs);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

export type DmPresenceStatus =
  | { kind: 'online' }
  | { kind: 'lastOnline'; label: string }
  | { kind: 'unknown' };

/** 1:1 header presence — peer only (never counts the viewer). */
export function dmPeerPresenceStatus(
  records: Map<string, PresenceRecord>,
  peerAddress: string | null | undefined,
): DmPresenceStatus {
  const record = findPresenceRecord(records, peerAddress);
  if (!record) return { kind: 'unknown' };
  if (record.online) return { kind: 'online' };
  const lastSeenAt = record.lastSeenAt ?? record.updatedAt;
  if (!lastSeenAt) return { kind: 'unknown' };
  return {
    kind: 'lastOnline',
    label: formatLastOnlineAt(lastSeenAt),
  };
}
