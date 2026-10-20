import type {GroupDigestInfo} from './social-api';

/**
 * Anchors the indexer has not listed yet.
 * A successful on-chain anchor is recorded here so the Verify list can show it
 * before the digest endpoint catches up. Once that endpoint returns the same
 * pointer, the temporary row is dropped.
 */
const pending = new Map<string, GroupDigestInfo[]>();
const listeners = new Set<() => void>();
let version = 0;

export function pendingDigestVersion(): number {
  return version;
}

export function subscribePendingDigests(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Remember a digest this client just anchored. A repeat of the same pointer is ignored. */
export function rememberAnchoredDigest(digest: GroupDigestInfo): void {
  const current = pending.get(digest.groupId) ?? [];
  if (current.some((row) => row.contentUri === digest.contentUri)) return;
  pending.set(digest.groupId, [...current, digest]);
  version += 1;
  for (const listener of listeners) listener();
}

/** Loaded indexer rows, plus any just-anchored digest the indexer does not have yet. */
export function mergePendingDigests(
  groupId: string,
  loaded: readonly GroupDigestInfo[],
): GroupDigestInfo[] {
  const extras = pending.get(groupId);
  if (!extras?.length) return [...loaded];
  const seen = new Set(loaded.map((row) => row.contentUri));
  let seq = loaded.reduce((max, row) => Math.max(max, row.seq), -1);
  const added: GroupDigestInfo[] = [];
  for (const extra of extras) {
    if (seen.has(extra.contentUri)) continue;
    seen.add(extra.contentUri);
    seq += 1;
    added.push({...extra, seq});
  }
  return [...loaded, ...added];
}

/** Test hook. Production never clears this except by the indexer catching up. */
export function resetPendingDigests(): void {
  pending.clear();
  version += 1;
}
