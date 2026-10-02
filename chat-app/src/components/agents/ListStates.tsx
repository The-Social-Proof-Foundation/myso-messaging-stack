import type React from 'react';

import type {PaginatedListResult} from '../../hooks/usePaginatedList';
import {cardClass, sectionTitleClass} from './chrome';

interface ListErrorProps {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}

export function listErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Something went wrong loading this list.';
}

/** Real failure text plus a retry, instead of rendering a failed query as "none yet". */
export function ListError({error, onRetry, className = ''}: Readonly<ListErrorProps>) {
  return (
    <div className={`px-4 py-3 text-xs text-danger-500 dark:text-danger-400 ${className}`}>
      <p className="break-words">{listErrorMessage(error)}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="mt-1 underline">
          Retry
        </button>
      ) : null}
    </div>
  );
}

interface LoadMoreRowProps {
  list: Pick<
    PaginatedListResult<unknown>,
    | 'count'
    | 'totalCount'
    | 'hasNextPage'
    | 'fetchNextPage'
    | 'isFetchingNextPage'
    | 'isFetchNextPageError'
    | 'pagingUnsupported'
    | 'truncated'
    | 'error'
  >;
  className?: string;
  /** Hide the "all loaded" line. Load-more, truncation, and paging errors still show. */
  showCompleteCount?: boolean;
}

/**
 * End-of-list control. Distinguishes "all loaded" from "stopped early" and from "this
 * server cannot page", so a partial list is never presented as the whole set.
 */
export function LoadMoreRow({
  list,
  className = '',
  showCompleteCount = true,
}: Readonly<LoadMoreRowProps>) {
  const loaded = `${list.count}${list.totalCount != null ? ` of ${list.totalCount}` : ''}`;

  let body: React.ReactNode = null;
  if (list.isFetchingNextPage) {
    body = (
      <span className="inline-flex items-center gap-2">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
        Loading more…
      </span>
    );
  } else if (list.isFetchNextPageError) {
    body = (
      <span className="text-danger-500 dark:text-danger-400">
        Could not load the next page.{' '}
        <button type="button" onClick={list.fetchNextPage} className="underline">
          Retry
        </button>
      </span>
    );
  } else if (list.hasNextPage) {
    body = (
      <button
        type="button"
        onClick={list.fetchNextPage}
        className="underline transition-colors hover:text-secondary-700 dark:hover:text-secondary-200"
      >
        Load more ({loaded})
      </button>
    );
  } else if (list.pagingUnsupported) {
    body = <span>Showing the first {list.count} — this server does not support paging yet.</span>;
  } else if (list.truncated) {
    body = (
      <span>
        Showing {loaded} — the list ended early.{' '}
        <button type="button" onClick={list.fetchNextPage} className="underline">
          Retry
        </button>
      </span>
    );
  } else if (showCompleteCount) {
    body = <span>All {loaded} loaded.</span>;
  }

  if (!body) return null;

  return (
    <div className={`px-4 py-2 text-xs text-secondary-500 dark:text-secondary-400 ${className}`}>
      {body}
    </div>
  );
}

interface ListSectionProps<T> {
  title: string;
  list: PaginatedListResult<T>;
  empty: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  showCompleteCount?: boolean;
}

/**
 * A dashboard section that owns its list's four states.
 *
 * Sections are independent so one failing read (for example an auditor-gated audit log)
 * cannot blank the rest of the organization dashboard.
 */
export function ListSection<T>({
  title,
  list,
  empty,
  children,
  action,
  showCompleteCount = true,
}: Readonly<ListSectionProps<T>>) {
  return (
    <section className={`${cardClass} p-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={`min-w-0 flex-1 ${sectionTitleClass}`}>{title}</h3>
        {action}
      </div>
      {list.isInitialLoading ? (
        <p className="mt-2 text-xs text-secondary-500 dark:text-secondary-400">Loading…</p>
      ) : list.isError ? (
        <ListError error={list.error} onRetry={list.refetch} className="mt-2 px-0" />
      ) : list.items.length === 0 ? (
        <p className="mt-2 text-xs text-secondary-500 dark:text-secondary-400">{empty}</p>
      ) : (
        <>
          {children}
          <LoadMoreRow list={list} className="px-0" showCompleteCount={showCompleteCount} />
        </>
      )}
    </section>
  );
}
