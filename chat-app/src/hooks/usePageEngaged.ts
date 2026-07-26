import { useSyncExternalStore } from 'react';
import {
  getPageEngagedSnapshot,
  getServerPageEngagedSnapshot,
  subscribePageEngagementStore,
} from '../lib/page-engagement';

/**
 * True when this document is visible and focused (user is actively reading).
 * False in background tabs, other windows, or after pagehide (bfcache).
 */
export function usePageEngaged(): boolean {
  return useSyncExternalStore(
    subscribePageEngagementStore,
    getPageEngagedSnapshot,
    getServerPageEngagedSnapshot,
  );
}
