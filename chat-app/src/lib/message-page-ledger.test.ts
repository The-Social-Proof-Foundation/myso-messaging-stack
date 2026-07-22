import {describe, expect, it} from 'vitest';
import {
  applyNewerOrdersToLedger,
  applyOlderPageToLedger,
  emptyPageLedger,
  hasFetchedBeforeOrder,
  invalidateLedgerAfterTrim,
  ledgerFromMessages,
  shouldFetchOlderPage,
  shouldWarmCatchUpOnly,
} from './message-page-ledger';

describe('message-page-ledger', () => {
  it('seeds a contiguous window from tip messages', () => {
    const ledger = ledgerFromMessages([10, 11, 12], true, 1_700_000_000_000);
    expect(ledger.minOrder).toBe(10);
    expect(ledger.maxOrder).toBe(12);
    expect(ledger.hasMoreOlder).toBe(true);
    expect(ledger.fetchedBeforeOrders).toEqual([]);
    expect(shouldWarmCatchUpOnly(ledger)).toBe(true);
  });

  it('warm catch-up only when min and max are set', () => {
    expect(shouldWarmCatchUpOnly(emptyPageLedger())).toBe(false);
    expect(
      shouldWarmCatchUpOnly({
        ...emptyPageLedger(),
        minOrder: 1,
        maxOrder: null,
      }),
    ).toBe(false);
  });

  it('records before_order cursors and refuses a second fetch for the same cursor', () => {
    let ledger = ledgerFromMessages([20, 21, 22], true);
    const first = shouldFetchOlderPage(ledger, {
      isLoadingOlder: false,
      isLoadingInitial: false,
      messageCount: 3,
    });
    expect(first).toEqual({fetch: true, beforeOrder: 20});

    ledger = applyOlderPageToLedger(ledger, 20, [17, 18, 19], true);
    expect(hasFetchedBeforeOrder(ledger, 20)).toBe(true);
    expect(ledger.minOrder).toBe(17);
    expect(ledger.hasMoreOlder).toBe(true);

    // Same cursor must not be requested again.
    const replay = shouldFetchOlderPage(
      {...ledger, minOrder: 20},
      {
        isLoadingOlder: false,
        isLoadingInitial: false,
        messageCount: 6,
      },
    );
    expect(replay).toEqual({fetch: false});

    // Next older page uses the new min.
    const second = shouldFetchOlderPage(ledger, {
      isLoadingOlder: false,
      isLoadingInitial: false,
      messageCount: 6,
    });
    expect(second).toEqual({fetch: true, beforeOrder: 17});
  });

  it('stops paging when an older page returns empty despite hasNext', () => {
    const ledger = applyOlderPageToLedger(
      ledgerFromMessages([5], true),
      5,
      [],
      true,
    );
    expect(ledger.hasMoreOlder).toBe(false);
    expect(hasFetchedBeforeOrder(ledger, 5)).toBe(true);
  });

  it('advances maxOrder on catch-up without clearing older flags', () => {
    const base = ledgerFromMessages([1, 2, 3], true);
    const next = applyNewerOrdersToLedger(base, [4, 5], 99);
    expect(next.minOrder).toBe(1);
    expect(next.maxOrder).toBe(5);
    expect(next.hasMoreOlder).toBe(true);
    expect(next.tipSyncedAt).toBe(99);
    expect(next.fetchedBeforeOrders).toEqual([]);
  });

  it('invalidates cursors after trimming oldest messages', () => {
    let ledger = ledgerFromMessages([12, 13], true);
    ledger = applyOlderPageToLedger(ledger, 12, [10, 11], false);
    expect(ledger.minOrder).toBe(10);
    expect(hasFetchedBeforeOrder(ledger, 12)).toBe(true);

    // Drop 10–11; new min is 12. Cursors >= min must clear so before_order=12
    // can load that range again.
    const remaining = [12, 13];
    const afterTrim = invalidateLedgerAfterTrim(ledger, remaining, true);
    expect(afterTrim.hasMoreOlder).toBe(true);
    expect(afterTrim.minOrder).toBe(12);
    expect(afterTrim.maxOrder).toBe(13);
    expect(hasFetchedBeforeOrder(afterTrim, 12)).toBe(false);
  });

  it('gates older fetches while loading', () => {
    const ledger = ledgerFromMessages([3], true);
    expect(
      shouldFetchOlderPage(ledger, {
        isLoadingOlder: true,
        isLoadingInitial: false,
        messageCount: 1,
      }),
    ).toEqual({fetch: false});
    expect(
      shouldFetchOlderPage(ledger, {
        isLoadingOlder: false,
        isLoadingInitial: true,
        messageCount: 1,
      }),
    ).toEqual({fetch: false});
    expect(
      shouldFetchOlderPage(ledger, {
        isLoadingOlder: false,
        isLoadingInitial: false,
        messageCount: 0,
      }),
    ).toEqual({fetch: false});
  });
});
