/**
 * In-memory decrypted thread cache for the browser session.
 *
 * Privacy: plaintext lives only in RAM for this tab. Cleared on logout /
 * messaging-client teardown. Never written to localStorage or IndexedDB.
 */
import type { RelayerReactionEntry } from '@socialproof/myso-messaging-stack';
import {
  coercePageLedger,
  emptyPageLedger,
  invalidateLedgerAfterTrim,
  type ThreadPageLedger,
} from './message-page-ledger';

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
  /** @deprecated Prefer `pageLedger.hasMoreOlder` — kept for callers during migration. */
  hasMore: boolean;
  reactions: CachedReactions;
  pageLedger: ThreadPageLedger;
  cachedAt: number;
};

const MAX_CACHED_GROUPS = 20;
/** Raised so pagination is less likely to fight trim mid-session. */
const MAX_MESSAGES_PER_GROUP = 300;

/** Insertion-ordered Map: oldest key is first; touch moves to end (LRU). */
const threads = new Map<string, CachedThread>();

function cloneReactions(reactions: CachedReactions): CachedReactions {
  return new Map(
    [...reactions.entries()].map(([order, rows]) => [order, [...rows]]),
  );
}

function cloneLedger(ledger: ThreadPageLedger): ThreadPageLedger {
  return {
    fetchedBeforeOrders: [...ledger.fetchedBeforeOrders],
    minOrder: ledger.minOrder,
    maxOrder: ledger.maxOrder,
    hasMoreOlder: ledger.hasMoreOlder,
    tipSyncedAt: ledger.tipSyncedAt,
  };
}

function trimMessagesWithLedger(
  messages: CachedMessage[],
  ledger: ThreadPageLedger,
): {messages: CachedMessage[]; ledger: ThreadPageLedger} {
  if (messages.length <= MAX_MESSAGES_PER_GROUP) {
    return {messages, ledger};
  }
  const trimmed = messages.slice(messages.length - MAX_MESSAGES_PER_GROUP);
  const remainingOrders = trimmed.map((m) => m.order);
  return {
    messages: trimmed,
    ledger: invalidateLedgerAfterTrim(ledger, remainingOrders, true),
  };
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
  const orders = entry.messages.map((m) => m.order);
  const pageLedger = coercePageLedger(
    entry.pageLedger,
    orders,
    entry.hasMore,
  );
  return {
    messages: [...entry.messages],
    hasMore: pageLedger.hasMoreOlder,
    reactions: cloneReactions(entry.reactions),
    pageLedger: cloneLedger(pageLedger),
    cachedAt: entry.cachedAt,
  };
}

export function setCachedThread(
  uuid: string,
  entry: {
    messages: CachedMessage[];
    hasMore?: boolean;
    reactions: CachedReactions;
    pageLedger?: ThreadPageLedger;
    cachedAt?: number;
  },
): ThreadPageLedger {
  const orders = entry.messages.map((m) => m.order);
  const pageLedger = coercePageLedger(
    entry.pageLedger,
    orders,
    entry.hasMore ?? entry.pageLedger?.hasMoreOlder,
  );
  const trimmed = trimMessagesWithLedger(entry.messages, pageLedger);
  touch(uuid, {
    messages: trimmed.messages,
    hasMore: trimmed.ledger.hasMoreOlder,
    reactions: cloneReactions(entry.reactions),
    pageLedger: trimmed.ledger,
    cachedAt: entry.cachedAt ?? Date.now(),
  });
  return cloneLedger(trimmed.ledger);
}

export function updateCachedThread(
  uuid: string,
  updater: (prev: CachedThread) => CachedThread | null,
): void {
  const prev = threads.get(uuid);
  if (!prev) return;
  const orders = prev.messages.map((m) => m.order);
  const pageLedger = coercePageLedger(prev.pageLedger, orders, prev.hasMore);
  const next = updater({
    messages: [...prev.messages],
    hasMore: pageLedger.hasMoreOlder,
    reactions: cloneReactions(prev.reactions),
    pageLedger: cloneLedger(pageLedger),
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

/** Test helper — expose empty ledger factory without importing ledger from callers. */
export function createEmptyCachedLedger(): ThreadPageLedger {
  return emptyPageLedger();
}
