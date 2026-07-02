import type { GroupPresenceEntry } from '@socialproof/myso-messaging-stack';

/** Stricter than the relayer snapshot window (60s) for initial paint. */
export const PRESENCE_SNAPSHOT_MAX_AGE_MS = 25_000;

/** WS updates within this window are not overwritten by snapshot reconciliation. */
export const PRESENCE_WS_FRESH_MS = 15_000;

/** Mark WS-sourced online members offline if no update within this window. */
export const PRESENCE_WS_STALE_MS = 15_000;

export type PresenceSource = 'ws' | 'snapshot';

export interface PresenceRecord {
  online: boolean;
  updatedAt: number;
  source: PresenceSource;
}

/** Derive online from snapshot using lastSeen when available. */
export function deriveOnlineFromSnapshot(entry: GroupPresenceEntry): boolean {
  if (entry.lastSeen) {
    const seenMs = Date.parse(entry.lastSeen);
    if (Number.isFinite(seenMs)) {
      return Date.now() - seenMs <= PRESENCE_SNAPSHOT_MAX_AGE_MS;
    }
  }
  return entry.online;
}

/** Merge a presence update; WS events always win over snapshot for that member. */
export function mergePresenceRecord(
  prev: PresenceRecord | undefined,
  online: boolean,
  source: PresenceSource,
): PresenceRecord {
  const now = Date.now();
  if (source === 'ws') {
    return { online, updatedAt: now, source: 'ws' };
  }
  if (prev?.source === 'ws' && now - prev.updatedAt < PRESENCE_WS_FRESH_MS) {
    return prev;
  }
  return { online, updatedAt: now, source: 'snapshot' };
}

export function applySnapshotEntries(
  prev: Map<string, PresenceRecord>,
  entries: GroupPresenceEntry[],
): Map<string, PresenceRecord> {
  const next = new Map(prev);
  for (const entry of entries) {
    const online = deriveOnlineFromSnapshot(entry);
    next.set(
      entry.member,
      mergePresenceRecord(next.get(entry.member), online, 'snapshot'),
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
  next.set(member, mergePresenceRecord(next.get(member), online, 'ws'));
  return next;
}

/** Sweep stale WS-sourced online records (missed offline events). */
export function sweepStaleWsPresence(
  prev: Map<string, PresenceRecord>,
  now = Date.now(),
): Map<string, PresenceRecord> {
  let changed = false;
  const next = new Map(prev);
  for (const [member, record] of next) {
    if (
      record.source === 'ws' &&
      record.online &&
      now - record.updatedAt > PRESENCE_WS_STALE_MS
    ) {
      next.set(member, { online: false, updatedAt: now, source: 'ws' });
      changed = true;
    }
  }
  return changed ? next : prev;
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
