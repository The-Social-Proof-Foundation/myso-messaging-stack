/**
 * In-memory decrypted thread cache for the browser session.
 *
 * Privacy: plaintext lives only in RAM for this tab. Cleared on logout /
 * messaging-client teardown. Never written to localStorage or IndexedDB.
 */
import type { RelayerReactionEntry } from '@socialproof/myso-messaging-stack';

/** Mirrors chat-app Message — kept local to avoid import cycles with useMessages. */
export interface CachedMessage {
  messageId: string;
  groupId: string;
  order: number;
  text: string;
  senderAddress: string;
  createdAt: number;
  updatedAt: number;
  isEdited: boolean;
  isDeleted: boolean;
  syncStatus?: string;
  attachments: unknown[];
  senderVerified: boolean;
  isAgentMessage?: boolean;
  principalOwner?: string;
  subAgentId?: string;
}

export type CachedReactions = Map<number, RelayerReactionEntry[]>;

export type CachedThread = {
  messages: CachedMessage[];
  hasMore: boolean;
  reactions: CachedReactions;
  cachedAt: number;
};

const MAX_CACHED_GROUPS = 20;
const MAX_MESSAGES_PER_GROUP = 150;

/** Insertion-ordered Map: oldest key is first; touch moves to end (LRU). */
const threads = new Map<string, CachedThread>();

function cloneReactions(reactions: CachedReactions): CachedReactions {
  return new Map(
    [...reactions.entries()].map(([order, rows]) => [order, [...rows]]),
  );
}

function trimMessages(messages: CachedMessage[]): CachedMessage[] {
  if (messages.length <= MAX_MESSAGES_PER_GROUP) return messages;
  return messages.slice(messages.length - MAX_MESSAGES_PER_GROUP);
}

function touch(uuid: string, entry: CachedThread): void {
  threads.delete(uuid);
  threads.set(uuid, entry);
  while (threads.size > MAX_CACHED_GROUPS) {
    const oldest = threads.keys().next().value;
    if (oldest === undefined) break;
    threads.delete(oldest);
  }
}

export function getCachedThread(uuid: string): CachedThread | null {
  const entry = threads.get(uuid);
  if (!entry) return null;
  // LRU: recently read groups stay.
  threads.delete(uuid);
  threads.set(uuid, entry);
  return {
    messages: [...entry.messages],
    hasMore: entry.hasMore,
    reactions: cloneReactions(entry.reactions),
    cachedAt: entry.cachedAt,
  };
}

export function setCachedThread(
  uuid: string,
  entry: {
    messages: CachedMessage[];
    hasMore: boolean;
    reactions: CachedReactions;
    cachedAt?: number;
  },
): void {
  touch(uuid, {
    messages: trimMessages(entry.messages),
    hasMore: entry.hasMore,
    reactions: cloneReactions(entry.reactions),
    cachedAt: entry.cachedAt ?? Date.now(),
  });
}

export function updateCachedThread(
  uuid: string,
  updater: (prev: CachedThread) => CachedThread | null,
): void {
  const prev = threads.get(uuid);
  if (!prev) return;
  const next = updater({
    messages: [...prev.messages],
    hasMore: prev.hasMore,
    reactions: cloneReactions(prev.reactions),
    cachedAt: prev.cachedAt,
  });
  if (!next) {
    threads.delete(uuid);
    return;
  }
  setCachedThread(uuid, next);
}

/** Wipe all plaintext threads (logout / client teardown). */
export function clearMessageCache(): void {
  threads.clear();
}
