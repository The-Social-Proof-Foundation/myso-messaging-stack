import {createContext, useContext, type ReactNode} from 'react';

interface UnreadCountsValue {
  counts: Record<string, number>;
  /** The chat currently on screen. Its badge stays clear while you are in it. */
  selectedGroupId: string | null;
}

const UnreadCountsContext = createContext<UnreadCountsValue>({counts: {}, selectedGroupId: null});

export function UnreadCountsProvider({
  counts,
  selectedGroupId,
  children,
}: Readonly<{counts: Record<string, number>; selectedGroupId: string | null; children: ReactNode}>) {
  return (
    <UnreadCountsContext.Provider value={{counts, selectedGroupId}}>{children}</UnreadCountsContext.Provider>
  );
}

export function useUnreadCounts(): UnreadCountsValue {
  return useContext(UnreadCountsContext);
}

/** Unread count for a row. The open chat is always clear. */
export function unreadCountFor(state: UnreadCountsValue, groupId: string): number {
  if (state.selectedGroupId && state.selectedGroupId.toLowerCase() === groupId.toLowerCase()) return 0;
  return state.counts[groupId] ?? 0;
}

/** Same pill the main chat list uses. */
export function UnreadCountBadge({count}: Readonly<{count: number}>) {
  if (count <= 0) return null;
  return (
    <span className="inline-flex min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-bubble-sent px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white dark:bg-bubble-sent-dark">
      {count > 99 ? '99+' : count}
    </span>
  );
}
