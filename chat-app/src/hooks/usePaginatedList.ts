import {useCallback, useMemo} from 'react';
import {useInfiniteQuery, type QueryKey} from '@tanstack/react-query';

import {
  clampLimit,
  flattenPages,
  makePagedQueryFn,
  nextPageRequest,
  pagesPagingUnsupported,
  pagesTotalCount,
  type PageFetcher,
  type PageRequest,
  type PagedPage,
} from '../lib/pagination';

export interface UsePaginatedListOptions<T> {
  queryKey: QueryKey;
  fetchPage: PageFetcher<T>;
  keyOf: (row: T) => string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}

export interface PaginatedListResult<T> {
  items: T[];
  /** Server-reported total when the endpoint provides one. */
  totalCount: number | null;
  /** Number of unique rows currently loaded (may be < totalCount). */
  count: number;
  isInitialLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  isEmpty: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  isFetchingNextPage: boolean;
  /** A later page failed while earlier pages are already on screen. */
  isFetchNextPageError: boolean;
  /** The endpoint rejected pagination params, so only the first page exists. */
  pagingUnsupported: boolean;
  /** The walk stopped early (server inconsistency or a failed page). */
  truncated: boolean;
  /** Every row was retrieved and the list is known to be whole. */
  complete: boolean;
  refetch: () => void;
}

/**
 * Progressive, de-duplicated list reads over an offset-paged endpoint.
 *
 * End-of-list state comes from the loaded pages on every render (never from closure
 * state), so React Query refetches — which re-run every page — cannot desynchronise the
 * pager. `truncated` is deliberately separate from `hasNextPage`: a list that stopped
 * because the page failed or the server would not page must not render as complete.
 */
export function usePaginatedList<T>(
  options: UsePaginatedListOptions<T>,
): PaginatedListResult<T> {
  const { queryKey, fetchPage, keyOf, enabled = true, limit, staleTime } = options;
  const pageLimit = clampLimit(limit);
  const runPage = useMemo(() => makePagedQueryFn(fetchPage), [fetchPage]);

  const query = useInfiniteQuery({
    queryKey,
    enabled,
    staleTime,
    initialPageParam: { limit: pageLimit, offset: 0 } satisfies PageRequest,
    queryFn: ({ pageParam, signal }) => runPage({ pageParam, signal }),
    getNextPageParam: (_lastPage, allPages) =>
      nextPageRequest(allPages as PagedPage<T>[], keyOf),
  });

  const pages = useMemo(
    () => (query.data?.pages ?? []) as PagedPage<T>[],
    [query.data?.pages],
  );

  const items = useMemo(() => flattenPages(pages, keyOf), [pages, keyOf]);
  const totalCount = useMemo(() => pagesTotalCount(pages), [pages]);
  const pagingUnsupported = useMemo(() => pagesPagingUnsupported(pages), [pages]);

  const lastPage = pages[pages.length - 1];
  const hasNextPage = Boolean(query.hasNextPage);
  const stoppedOnFullPage = lastPage ? lastPage.items.length >= lastPage.request.limit : false;
  const reachedTotal = totalCount != null && items.length >= totalCount;
  const truncated =
    Boolean(lastPage) && !hasNextPage && (pagingUnsupported || (stoppedOnFullPage && !reachedTotal));
  const complete = Boolean(lastPage) && !hasNextPage && !truncated;

  const fetchNextPage = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query]);

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    items,
    totalCount,
    count: items.length,
    isInitialLoading: query.isPending && enabled,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    isEmpty: Boolean(lastPage) && items.length === 0,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    pagingUnsupported,
    truncated,
    complete,
    refetch,
  };
}
