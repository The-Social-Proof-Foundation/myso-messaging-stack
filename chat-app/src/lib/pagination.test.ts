import {describe, expect, it} from 'vitest';

import {
  clampLimit,
  collectAllPages,
  flattenPages,
  MAX_PAGE_LIMIT,
  nextPageRequest,
  pagesPagingUnsupported,
  pagesTotalCount,
  type PageFetcher,
  type PageRequest,
} from './pagination';

interface Row {
  id: string;
}

function rows(count: number, prefix = 'r'): Row[] {
  return Array.from({length: count}, (_, i) => ({id: `${prefix}${i}`}));
}

const keyOf = (row: Row) => row.id;

/** Slices a fixed dataset like a well-behaved server. */
function datasetFetcher(
  data: Row[],
  options: {reportTotal?: boolean; ignoreOffset?: boolean} = {},
) {
  const calls: PageRequest[] = [];
  const fetchPage: PageFetcher<Row> = async (request) => {
    calls.push({...request});
    const start = options.ignoreOffset ? 0 : request.offset;
    return {
      items: data.slice(start, start + request.limit),
      totalCount: options.reportTotal === false ? null : data.length,
    };
  };
  return {fetchPage, calls};
}

describe('clampLimit', () => {
  it('defaults to the server maximum and clamps out-of-range values', () => {
    expect(clampLimit(undefined)).toBe(MAX_PAGE_LIMIT);
    expect(clampLimit(Number.NaN)).toBe(MAX_PAGE_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(250)).toBe(MAX_PAGE_LIMIT);
    expect(clampLimit(25)).toBe(25);
  });
});

describe('collectAllPages', () => {
  it('walks every page past the 100-row server cap', async () => {
    const {fetchPage, calls} = datasetFetcher(rows(150));

    const result = await collectAllPages(fetchPage, {keyOf});

    expect(calls).toEqual([
      {limit: 100, offset: 0},
      {limit: 100, offset: 100},
    ]);
    expect(result.items).toHaveLength(150);
    expect(new Set(result.items.map(keyOf)).size).toBe(150);
    expect(result.totalCount).toBe(150);
    expect(result.complete).toBe(true);
    expect(result.reason).toBe('short-page');
    expect(result.pages).toBe(2);
    expect(result.partialError).toBeNull();
  });

  it('stops on an exact page boundary using the reported total', async () => {
    const {fetchPage, calls} = datasetFetcher(rows(100));

    const result = await collectAllPages(fetchPage, {keyOf});

    expect(calls).toHaveLength(1);
    expect(result.items).toHaveLength(100);
    expect(result.reason).toBe('total-count');
    expect(result.complete).toBe(true);
  });

  it('issues one extra request on an exact boundary when no total is reported', async () => {
    const {fetchPage, calls} = datasetFetcher(rows(100), {reportTotal: false});

    const result = await collectAllPages(fetchPage, {keyOf});

    expect(calls).toEqual([
      {limit: 100, offset: 0},
      {limit: 100, offset: 100},
    ]);
    expect(result.items).toHaveLength(100);
    expect(result.totalCount).toBeNull();
    expect(result.reason).toBe('empty-page');
    expect(result.complete).toBe(true);
  });

  it('terminates on a short page without a second request', async () => {
    const {fetchPage, calls} = datasetFetcher(rows(37));

    const result = await collectAllPages(fetchPage, {keyOf});

    expect(calls).toHaveLength(1);
    expect(result.items).toHaveLength(37);
    expect(result.reason).toBe('short-page');
    expect(result.complete).toBe(true);
  });

  it('treats an empty first page as a complete empty list', async () => {
    const {fetchPage, calls} = datasetFetcher([]);

    const result = await collectAllPages(fetchPage, {keyOf});

    expect(calls).toHaveLength(1);
    expect(result.items).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.pages).toBe(1);
  });

  it('de-duplicates rows repeated across overlapping pages and keeps walking', async () => {
    const data = rows(200);
    const calls: PageRequest[] = [];
    // A server whose offset advances by half a page — rows overlap by 50.
    const fetchPage: PageFetcher<Row> = async (request) => {
      calls.push({...request});
      const start = Math.min(request.offset, 100);
      return {items: data.slice(start, start + request.limit), totalCount: data.length};
    };

    const result = await collectAllPages(fetchPage, {keyOf});

    expect(result.complete).toBe(true);
    expect(result.items).toHaveLength(200);
    expect(new Set(result.items.map(keyOf)).size).toBe(200);
    expect(calls.length).toBeGreaterThan(1);
  });

  it('stops as soon as the reported total is reached', async () => {
    const {fetchPage, calls} = datasetFetcher(rows(100));

    const result = await collectAllPages(fetchPage, {keyOf});

    expect(result.reason).toBe('total-count');
    expect(calls).toHaveLength(1);
  });

  it('stops when a full page adds nothing new instead of looping forever', async () => {
    // Server ignores `offset`: every request returns the same full page.
    const {fetchPage, calls} = datasetFetcher(rows(100), {
      ignoreOffset: true,
      reportTotal: false,
    });

    const result = await collectAllPages(fetchPage, {keyOf});

    expect(result.reason).toBe('no-progress');
    expect(result.complete).toBe(false);
    expect(calls).toHaveLength(2);
    expect(result.items).toHaveLength(100);
  });

  it('honours maxPages when every page is full and new', async () => {
    let counter = 0;
    const calls: PageRequest[] = [];
    const fetchPage: PageFetcher<Row> = async (request) => {
      calls.push({...request});
      const page = rows(request.limit, `p${counter}-`);
      counter += 1;
      return {items: page, totalCount: null};
    };

    const result = await collectAllPages(fetchPage, {keyOf, maxPages: 3});

    expect(calls).toHaveLength(3);
    expect(result.pages).toBe(3);
    expect(result.reason).toBe('max-pages');
    expect(result.complete).toBe(false);
    expect(result.items).toHaveLength(300);
  });

  it('marks the list incomplete when the server rejects pagination params', async () => {
    const {fetchPage} = datasetFetcher(rows(20));
    const legacy: PageFetcher<Row> = async (request) => {
      const page = await fetchPage(request);
      return {...page, totalCount: null, pagingSupported: false};
    };

    const result = await collectAllPages(legacy, {keyOf});

    expect(result.reason).toBe('unsupported');
    expect(result.complete).toBe(false);
    expect(result.items).toHaveLength(20);
  });

  it('returns partial rows when a later page fails', async () => {
    const data = rows(300);
    const calls: PageRequest[] = [];
    const fetchPage: PageFetcher<Row> = async (request) => {
      calls.push({...request});
      if (request.offset >= 200) throw new Error('boom');
      return {items: data.slice(request.offset, request.offset + request.limit), totalCount: 300};
    };

    const result = await collectAllPages(fetchPage, {keyOf});

    expect(calls).toHaveLength(3);
    expect(result.items).toHaveLength(200);
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('error');
    expect(result.partialError).toBeInstanceOf(Error);
  });

  it('rethrows a first-page failure so the caller owns the initial error state', async () => {
    const fetchPage: PageFetcher<Row> = async () => {
      throw new Error('offline');
    };

    await expect(collectAllPages(fetchPage, {keyOf})).rejects.toThrow('offline');
  });

  it('stops without requesting when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const {fetchPage, calls} = datasetFetcher(rows(300));

    const result = await collectAllPages(fetchPage, {keyOf, signal: controller.signal});

    expect(calls).toHaveLength(0);
    expect(result.items).toEqual([]);
    expect(result.reason).toBe('aborted');
    expect(result.complete).toBe(false);
  });

  it('stops between pages when aborted mid-walk', async () => {
    const controller = new AbortController();
    const data = rows(300);
    const calls: PageRequest[] = [];
    const fetchPage: PageFetcher<Row> = async (request) => {
      calls.push({...request});
      controller.abort();
      return {items: data.slice(request.offset, request.offset + request.limit), totalCount: 300};
    };

    const result = await collectAllPages(fetchPage, {keyOf, signal: controller.signal});

    expect(calls).toHaveLength(1);
    expect(result.items).toHaveLength(100);
    expect(result.reason).toBe('aborted');
    expect(result.complete).toBe(false);
  });

  it('uses a custom page limit and reports it in each request', async () => {
    const {fetchPage, calls} = datasetFetcher(rows(45));

    const result = await collectAllPages(fetchPage, {keyOf, limit: 20});

    expect(calls).toEqual([
      {limit: 20, offset: 0},
      {limit: 20, offset: 20},
      {limit: 20, offset: 40},
    ]);
    expect(result.items).toHaveLength(45);
    expect(result.complete).toBe(true);
  });
});

describe('nextPageRequest', () => {
  const page = (
    items: Row[],
    request: PageRequest,
    extras: {totalCount?: number | null; pagingSupported?: boolean} = {},
  ) => ({
    items,
    request,
    totalCount: extras.totalCount === undefined ? null : extras.totalCount,
    pagingSupported: extras.pagingSupported,
  });

  it('advances by the rows actually received', () => {
    const next = nextPageRequest([page(rows(100), {limit: 100, offset: 0})], keyOf);
    expect(next).toEqual({limit: 100, offset: 100});
  });

  it('stops on a short page, an empty page, and at the reported total', () => {
    expect(nextPageRequest([page(rows(10), {limit: 100, offset: 0})], keyOf)).toBeNull();
    expect(nextPageRequest([page([], {limit: 100, offset: 0})], keyOf)).toBeNull();
    expect(
      nextPageRequest([page(rows(100), {limit: 100, offset: 0}, {totalCount: 100})], keyOf),
    ).toBeNull();
  });

  it('continues while the reported total is not yet reached', () => {
    const next = nextPageRequest(
      [page(rows(100), {limit: 100, offset: 0}, {totalCount: 150})],
      keyOf,
    );
    expect(next).toEqual({limit: 100, offset: 100});
  });

  it('stops on a full page that adds nothing new', () => {
    const allPages = [
      page(rows(100), {limit: 100, offset: 0}),
      page(rows(100), {limit: 100, offset: 100}),
    ];
    expect(nextPageRequest(allPages, keyOf)).toBeNull();
  });

  it('stops when the server does not support pagination', () => {
    const allPages = [page(rows(100), {limit: 100, offset: 0}, {pagingSupported: false})];
    expect(nextPageRequest(allPages, keyOf)).toBeNull();
  });
});

describe('flattenPages', () => {
  it('flattens and de-duplicates across pages', () => {
    const pages = [
      {items: rows(3), request: {limit: 3, offset: 0}, totalCount: 5},
      {items: rows(5).slice(1), request: {limit: 3, offset: 3}, totalCount: 5},
    ];

    expect(flattenPages(pages, keyOf).map(keyOf)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    expect(pagesTotalCount(pages)).toBe(5);
    expect(pagesPagingUnsupported(pages)).toBe(false);
  });

  it('reports unsupported pagination from any page', () => {
    const pages = [
      {items: rows(1), request: {limit: 1, offset: 0}, totalCount: null},
      {items: rows(1), request: {limit: 1, offset: 1}, totalCount: null, pagingSupported: false},
    ];
    expect(pagesPagingUnsupported(pages)).toBe(true);
  });
});
