/**
 * Deterministic list pagination.
 *
 * Every paged agentic/enterprise read goes through here so that offset handling,
 * de-duplication, end-of-list detection, and loop guards live in exactly one place.
 *
 * Two entry points:
 *  - {@link collectAllPages} walks every page up front. Use it when the caller needs the
 *    complete set (key derivation bounds, integrity checks, tests).
 *  - {@link nextPageRequest} drives `useInfiniteQuery` for progressive "Load more" lists.
 *
 * The server clamps `limit` to 100 (`PageParams::limit()`), so a caller that wants
 * everything must page. Endpoints differ in what they report:
 *  - `{organizations|sub_agents, total_count}` → exact total, authoritative stop.
 *  - bare arrays → no total; stop on a short or empty page.
 *  - legacy deployments that reject pagination params → `pagingSupported: false`, which is
 *    surfaced as an explicitly incomplete list rather than a silent truncation.
 *
 * All end-of-list state is derived from the loaded pages, never from closure state, so a
 * React Query refetch (which re-runs every page) cannot desynchronise the pager.
 */

/** Server-side clamp for `limit` (`PageParams::limit().min(100)`). */
export const MAX_PAGE_LIMIT = 100;

/** Hard ceiling on page walks so a broken server cannot spin the client forever. */
export const DEFAULT_MAX_PAGES = 50;

export interface PageRequest {
  limit: number;
  offset: number;
}

export interface PageResult<T> {
  items: T[];
  /** Exact row count when the endpoint reports one; `null` when it does not. */
  totalCount: number | null;
  /**
   * `false` when the request had to drop pagination params (legacy server). The list is
   * then first-page-only and must never be presented as complete.
   */
  pagingSupported?: boolean;
}

export type PageFetcher<T> = (
  request: PageRequest,
  signal?: AbortSignal,
) => Promise<PageResult<T>>;

export type StopReason =
  | 'empty-page'
  | 'short-page'
  | 'total-count'
  | 'no-progress'
  | 'max-pages'
  | 'unsupported'
  | 'error'
  | 'aborted';

const COMPLETE_REASONS: ReadonlySet<StopReason> = new Set<StopReason>([
  'empty-page',
  'short-page',
  'total-count',
]);

export interface CollectOptions<T> {
  limit?: number;
  maxPages?: number;
  keyOf: (row: T) => string;
  signal?: AbortSignal;
}

export interface CollectResult<T> {
  items: T[];
  totalCount: number | null;
  /** True only when the walk reached a genuine end of list. */
  complete: boolean;
  reason: StopReason;
  pages: number;
  /** Set when a page after the first failed: earlier rows are still returned. */
  partialError: unknown | null;
}

export function isCompleteReason(reason: StopReason): boolean {
  return COMPLETE_REASONS.has(reason);
}

export function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return MAX_PAGE_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_LIMIT);
}

/**
 * Walks pages until the list is exhausted. Never throws for a later-page failure — it
 * returns what it has plus `partialError`, because dropping already-fetched rows is worse
 * than showing a partial list with an error. The first page's failure is rethrown so the
 * caller's initial loading/error state stays accurate.
 */
export async function collectAllPages<T>(
  fetchPage: PageFetcher<T>,
  options: CollectOptions<T>,
): Promise<CollectResult<T>> {
  const limit = clampLimit(options.limit);
  const maxPages = Math.max(1, Math.trunc(options.maxPages ?? DEFAULT_MAX_PAGES));
  const { keyOf, signal } = options;

  const seen = new Set<string>();
  const items: T[] = [];
  let totalCount: number | null = null;
  let offset = 0;
  let pages = 0;

  const finish = (reason: StopReason, partialError: unknown | null = null): CollectResult<T> => ({
    items,
    totalCount,
    complete: isCompleteReason(reason),
    reason,
    pages,
    partialError,
  });

  while (pages < maxPages) {
    if (signal?.aborted) return finish('aborted');

    let page: PageResult<T>;
    try {
      page = await fetchPage({ limit, offset }, signal);
    } catch (error) {
      if (pages === 0) throw error;
      return finish('error', error);
    }
    pages += 1;

    if (page.totalCount != null && totalCount == null) {
      totalCount = page.totalCount;
    }

    let added = 0;
    for (const row of page.items) {
      const key = keyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(row);
      added += 1;
    }

    if (page.pagingSupported === false) return finish('unsupported');
    if (page.items.length === 0) return finish('empty-page');
    if (page.items.length < limit) return finish('short-page');
    if (totalCount != null && items.length >= totalCount) return finish('total-count');
    // A full page that contributed nothing new means offset paging is not advancing.
    // Stopping here is what keeps a misbehaving server from looping forever.
    if (added === 0) return finish('no-progress');
    if (signal?.aborted) return finish('aborted');

    offset += page.items.length;
  }

  return finish('max-pages');
}

export interface PagedPage<T> extends PageResult<T> {
  /** The request that produced this page. */
  request: PageRequest;
}

/** Wraps a {@link PageFetcher} into the shape `useInfiniteQuery` needs. */
export function makePagedQueryFn<T>(fetchPage: PageFetcher<T>) {
  return async ({
    pageParam,
    signal,
  }: {
    pageParam: PageRequest;
    signal?: AbortSignal;
  }): Promise<PagedPage<T>> => {
    const page = await fetchPage(pageParam, signal);
    return { ...page, request: pageParam };
  };
}

/**
 * Builds the next request for `useInfiniteQuery`, or `null` at the end of the list.
 * Mirrors {@link collectAllPages} stop conditions so both paths agree, and recomputes
 * de-duplication from `allPages` on every call so refetches stay correct.
 */
export function nextPageRequest<T>(
  allPages: PagedPage<T>[],
  keyOf: (row: T) => string,
): PageRequest | null {
  const last = allPages[allPages.length - 1];
  if (!last) return null;
  if (last.pagingSupported === false) return null;
  if (last.items.length === 0) return null;
  if (last.items.length < last.request.limit) return null;

  const collected = new Set<string>();
  for (let i = 0; i < allPages.length - 1; i += 1) {
    for (const row of allPages[i]!.items) collected.add(keyOf(row));
  }
  let newKeys = 0;
  for (const row of last.items) {
    const key = keyOf(row);
    if (collected.has(key)) continue;
    collected.add(key);
    newKeys += 1;
  }

  if (last.totalCount != null && collected.size >= last.totalCount) return null;
  if (newKeys === 0) return null;
  return { limit: last.request.limit, offset: last.request.offset + last.items.length };
}

/** Flattens infinite-query pages, de-duplicating by key across page boundaries. */
export function flattenPages<T>(pages: PagedPage<T>[], keyOf: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const page of pages) {
    for (const row of page.items) {
      const key = keyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

/** First non-null `totalCount` across loaded pages. */
export function pagesTotalCount<T>(pages: PagedPage<T>[]): number | null {
  for (const page of pages) {
    if (page.totalCount != null) return page.totalCount;
  }
  return null;
}

/** True when any loaded page reported that the server rejected pagination params. */
export function pagesPagingUnsupported<T>(pages: PagedPage<T>[]): boolean {
  return pages.some((page) => page.pagingSupported === false);
}
