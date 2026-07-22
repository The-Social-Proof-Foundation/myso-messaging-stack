/**
 * Contiguous message-window ledger for chat-app pagination.
 *
 * Tracks min/max order, older-page cursors already fetched, and trim
 * invalidation so warm opens catch up via `after_order` only and never
 * re-query a successfully loaded `before_order` page.
 */

export const MESSAGE_PAGE_SIZE = 50;
/** Bound catch-up loops when the tip jumped far ahead while offline. */
export const MESSAGE_CATCHUP_MAX_PAGES = 5;

export type ThreadPageLedger = {
  /** Exclusive `before_order` values already requested successfully. */
  fetchedBeforeOrders: number[];
  /** Contiguous loaded window (inclusive). */
  minOrder: number | null;
  maxOrder: number | null;
  hasMoreOlder: boolean;
  /** Last successful tip sync (wall clock). */
  tipSyncedAt: number;
};

export function emptyPageLedger(): ThreadPageLedger {
  return {
    fetchedBeforeOrders: [],
    minOrder: null,
    maxOrder: null,
    hasMoreOlder: false,
    tipSyncedAt: 0,
  };
}

/** Build a ledger from a sorted ascending message list. */
export function ledgerFromMessages(
  orders: number[],
  hasMoreOlder: boolean,
  tipSyncedAt: number = Date.now(),
): ThreadPageLedger {
  if (orders.length === 0) {
    return {
      ...emptyPageLedger(),
      hasMoreOlder,
      tipSyncedAt,
    };
  }
  return {
    fetchedBeforeOrders: [],
    minOrder: Math.min(...orders),
    maxOrder: Math.max(...orders),
    hasMoreOlder,
    tipSyncedAt,
  };
}

/** Normalize legacy cache entries that lack a page ledger. */
export function coercePageLedger(
  ledger: ThreadPageLedger | undefined,
  messageOrders: number[],
  legacyHasMore?: boolean,
): ThreadPageLedger {
  if (ledger && typeof ledger.hasMoreOlder === 'boolean') {
    return {
      fetchedBeforeOrders: [...ledger.fetchedBeforeOrders],
      minOrder: ledger.minOrder,
      maxOrder: ledger.maxOrder,
      hasMoreOlder: ledger.hasMoreOlder,
      tipSyncedAt: ledger.tipSyncedAt,
    };
  }
  return ledgerFromMessages(
    messageOrders,
    legacyHasMore ?? false,
    Date.now(),
  );
}

export function hasFetchedBeforeOrder(
  ledger: ThreadPageLedger,
  beforeOrder: number,
): boolean {
  return ledger.fetchedBeforeOrders.includes(beforeOrder);
}

/**
 * Record a successful older page. Caller passes the `beforeOrder` used for the
 * request and the orders returned (may be empty).
 */
export function applyOlderPageToLedger(
  ledger: ThreadPageLedger,
  beforeOrder: number,
  returnedOrders: number[],
  hasNext: boolean,
): ThreadPageLedger {
  const fetched = hasFetchedBeforeOrder(ledger, beforeOrder)
    ? [...ledger.fetchedBeforeOrders]
    : [...ledger.fetchedBeforeOrders, beforeOrder];

  let minOrder = ledger.minOrder;
  let maxOrder = ledger.maxOrder;
  for (const order of returnedOrders) {
    minOrder = minOrder === null ? order : Math.min(minOrder, order);
    maxOrder = maxOrder === null ? order : Math.max(maxOrder, order);
  }

  // Empty page with hasNext is a stuck cursor — stop paging.
  const hasMoreOlder =
    returnedOrders.length === 0 && hasNext ? false : hasNext;

  return {
    fetchedBeforeOrders: fetched,
    minOrder,
    maxOrder,
    hasMoreOlder,
    tipSyncedAt: ledger.tipSyncedAt,
  };
}

/** Merge catch-up / tip / WS newer orders into the ledger. */
export function applyNewerOrdersToLedger(
  ledger: ThreadPageLedger,
  returnedOrders: number[],
  tipSyncedAt: number = Date.now(),
): ThreadPageLedger {
  if (returnedOrders.length === 0) {
    return {...ledger, tipSyncedAt};
  }
  let minOrder = ledger.minOrder;
  let maxOrder = ledger.maxOrder;
  for (const order of returnedOrders) {
    minOrder = minOrder === null ? order : Math.min(minOrder, order);
    maxOrder = maxOrder === null ? order : Math.max(maxOrder, order);
  }
  return {
    ...ledger,
    minOrder,
    maxOrder,
    tipSyncedAt,
  };
}

/**
 * After trimming oldest messages, force `hasMoreOlder` and drop cursor entries
 * that can no longer protect the dropped range (`>=` new min).
 */
export function invalidateLedgerAfterTrim(
  ledger: ThreadPageLedger,
  remainingOrders: number[],
  didDropOldest: boolean,
): ThreadPageLedger {
  if (remainingOrders.length === 0) {
    return {
      ...emptyPageLedger(),
      hasMoreOlder: didDropOldest || ledger.hasMoreOlder,
      tipSyncedAt: ledger.tipSyncedAt,
    };
  }
  const minOrder = Math.min(...remainingOrders);
  const maxOrder = Math.max(...remainingOrders);
  const fetchedBeforeOrders = ledger.fetchedBeforeOrders.filter(
    (cursor) => cursor < minOrder,
  );
  return {
    fetchedBeforeOrders,
    minOrder,
    maxOrder,
    hasMoreOlder: didDropOldest ? true : ledger.hasMoreOlder,
    tipSyncedAt: ledger.tipSyncedAt,
  };
}

/** Whether an older fetch should hit the network for this cursor. */
export function shouldFetchOlderPage(
  ledger: ThreadPageLedger,
  opts: {
    isLoadingOlder: boolean;
    isLoadingInitial: boolean;
    messageCount: number;
  },
): {fetch: false} | {fetch: true; beforeOrder: number} {
  if (
    !ledger.hasMoreOlder ||
    opts.isLoadingOlder ||
    opts.isLoadingInitial ||
    opts.messageCount === 0 ||
    ledger.minOrder === null
  ) {
    return {fetch: false};
  }
  const beforeOrder = ledger.minOrder;
  if (hasFetchedBeforeOrder(ledger, beforeOrder)) {
    return {fetch: false};
  }
  return {fetch: true, beforeOrder};
}

/** Warm open uses catch-up only when the window already has a tip. */
export function shouldWarmCatchUpOnly(ledger: ThreadPageLedger): boolean {
  return ledger.maxOrder !== null && ledger.minOrder !== null;
}
