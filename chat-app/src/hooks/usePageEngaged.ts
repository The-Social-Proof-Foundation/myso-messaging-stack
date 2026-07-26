import { useSyncExternalStore } from 'react';
import {
  getPageEngagedSnapshot,
  getServerPageEngagedSnapshot,
  subscribePageEngagementStore,
} from '../lib/page-engagement';

/**
 * True when this document is visible and focused (user is actively reading).
 * False in background tabs, unfocused windows (other OS apps), or after pagehide.
 * Peer Online uses {@link usePageVisible} instead (visibility only).
 */
export function usePageEngaged(): boolean {
  return useSyncExternalStore(
    subscribePageEngagementStore,
    getPageEngagedSnapshot,
    getServerPageEngagedSnapshot,
  );
}
