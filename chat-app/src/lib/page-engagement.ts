/**
 * Document presence signals for the chat UI.
 *
 * - Visible (`isPageVisible`): tab is shown (`visibilityState === 'visible'`).
 *   Used for peer Online — stay Online when switching to another OS app while
 *   the chat tab remains open; go Offline when switching to another browser tab.
 * - Engaged (`isPageEngaged`): visible AND window focused. Used for mark-read,
 *   push-suppress presence, and typing (actively reading).
 *
 * Safari bfcache: `pagehide` forces both false until `pageshow`.
 */

type BooleanListener = (value: boolean) => void;

/** Set on `pagehide` (bfcache / unload); cleared on `pageshow`. */
let pagehideAway = false;

const engagementListeners = new Set<BooleanListener>();
const visibilityListeners = new Set<BooleanListener>();
let listening = false;
let lastEngagedEmitted: boolean | undefined;
let lastVisibleEmitted: boolean | undefined;

function browserAvailable(): boolean {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

/** Tab is visible (peer Online). Does not require window focus. */
export function isPageVisible(): boolean {
  if (!browserAvailable()) return false;
  if (pagehideAway) return false;
  return document.visibilityState === 'visible';
}

/** Visible and focused (actively reading). */
export function isPageEngaged(): boolean {
  if (!browserAvailable()) return false;
  if (pagehideAway) return false;
  return document.visibilityState === 'visible' && document.hasFocus();
}

function emitAll() {
  const visible = isPageVisible();
  const engaged = isPageEngaged();

  if (visible !== lastVisibleEmitted) {
    lastVisibleEmitted = visible;
    for (const cb of visibilityListeners) {
      cb(visible);
    }
  }

  if (engaged !== lastEngagedEmitted) {
    lastEngagedEmitted = engaged;
    for (const cb of engagementListeners) {
      cb(engaged);
    }
  }
}

function onPageHide() {
  pagehideAway = true;
  emitAll();
}

function onPageShow() {
  pagehideAway = false;
  emitAll();
}

function ensureListening() {
  if (listening || !browserAvailable()) return;
  listening = true;
  document.addEventListener('visibilitychange', emitAll);
  window.addEventListener('focus', emitAll);
  window.addEventListener('blur', emitAll);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
}

function maybeStopListening() {
  if (
    !listening ||
    engagementListeners.size > 0 ||
    visibilityListeners.size > 0 ||
    !browserAvailable()
  ) {
    return;
  }
  listening = false;
  lastEngagedEmitted = undefined;
  lastVisibleEmitted = undefined;
  document.removeEventListener('visibilitychange', emitAll);
  window.removeEventListener('focus', emitAll);
  window.removeEventListener('blur', emitAll);
  window.removeEventListener('pagehide', onPageHide);
  window.removeEventListener('pageshow', onPageShow);
}

/**
 * Subscribe to engagement changes. Immediately invokes `cb` with the current
 * value. Returns an unsubscribe function.
 */
export function subscribePageEngagement(cb: BooleanListener): () => void {
  ensureListening();
  engagementListeners.add(cb);
  const current = isPageEngaged();
  lastEngagedEmitted = current;
  cb(current);
  return () => {
    engagementListeners.delete(cb);
    maybeStopListening();
  };
}

/**
 * Subscribe to visibility changes (tab shown/hidden). Immediately invokes `cb`.
 */
export function subscribePageVisibility(cb: BooleanListener): () => void {
  ensureListening();
  visibilityListeners.add(cb);
  const current = isPageVisible();
  lastVisibleEmitted = current;
  cb(current);
  return () => {
    visibilityListeners.delete(cb);
    maybeStopListening();
  };
}

/** `useSyncExternalStore` subscribe — ignores the boolean payload. */
export function subscribePageEngagementStore(onStoreChange: () => void): () => void {
  return subscribePageEngagement(() => {
    onStoreChange();
  });
}

export function subscribePageVisibilityStore(onStoreChange: () => void): () => void {
  return subscribePageVisibility(() => {
    onStoreChange();
  });
}

export function getPageEngagedSnapshot(): boolean {
  return isPageEngaged();
}

export function getPageVisibleSnapshot(): boolean {
  return isPageVisible();
}

/** Server / SSR snapshot — never “reading” until hydrated in the browser. */
export function getServerPageEngagedSnapshot(): boolean {
  return false;
}

export function getServerPageVisibleSnapshot(): boolean {
  return false;
}

/** Test-only: reset module listeners / pagehide flag. */
export function __resetPageEngagementForTests(): void {
  pagehideAway = false;
  engagementListeners.clear();
  visibilityListeners.clear();
  lastEngagedEmitted = undefined;
  lastVisibleEmitted = undefined;
  if (listening && browserAvailable()) {
    document.removeEventListener('visibilitychange', emitAll);
    window.removeEventListener('focus', emitAll);
    window.removeEventListener('blur', emitAll);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
  }
  listening = false;
}
