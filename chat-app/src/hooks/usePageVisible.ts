import { useSyncExternalStore } from 'react';
import {
  getPageVisibleSnapshot,
  getServerPageVisibleSnapshot,
  subscribePageVisibilityStore,
} from '../lib/page-engagement';

/**
 * True when this document’s tab is visible (`visibilityState === 'visible'`).
 * Used for peer Online (WebSockets). Stays true when switching to another OS
 * app while the chat tab remains open; false when switching to another tab.
 */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribePageVisibilityStore,
    getPageVisibleSnapshot,
    getServerPageVisibleSnapshot,
  );
}
