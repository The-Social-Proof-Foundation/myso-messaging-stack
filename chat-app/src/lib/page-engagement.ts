/**
 * Document engagement for “actively present” in the chat UI.
 *
 * Engaged = tab visible AND window focused. Covers other browser tabs and
 * other OS windows via Page Visibility + focus/blur; Safari bfcache via
 * pagehide/pageshow.
 *
 * Callers use this to gate mark-read / push-suppress presence, pause typing,
 * and abort realtime WebSockets so peer Online flips Offline while away.
 */

type EngagementListener = (engaged: boolean) => void;

/** Set on `pagehide` (bfcache / unload); cleared on `pageshow`. */
let pagehideAway = false;

const listeners = new Set<EngagementListener>();
let listening = false;
let lastEmitted: boolean | undefined;

function browserAvailable(): boolean {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

/** Current engagement snapshot (safe to call outside React). */
export function isPageEngaged(): boolean {
  if (!browserAvailable()) return false;
  if (pagehideAway) return false;
  return document.visibilityState === 'visible' && document.hasFocus();
}

function emit() {
  const next = isPageEngaged();
  if (next === lastEmitted) return;
  lastEmitted = next;
  for (const cb of listeners) {
    cb(next);
  }
}

function onPageHide() {
  pagehideAway = true;
  emit();
}

function onPageShow() {
  pagehideAway = false;
  emit();
}

function ensureListening() {
  if (listening || !browserAvailable()) return;
  listening = true;
  document.addEventListener('visibilitychange', emit);
  window.addEventListener('focus', emit);
  window.addEventListener('blur', emit);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
}

function maybeStopListening() {
  if (!listening || listeners.size > 0 || !browserAvailable()) return;
  listening = false;
  lastEmitted = undefined;
  document.removeEventListener('visibilitychange', emit);
  window.removeEventListener('focus', emit);
  window.removeEventListener('blur', emit);
  window.removeEventListener('pagehide', onPageHide);
  window.removeEventListener('pageshow', onPageShow);
}

/**
 * Subscribe to engagement changes. Immediately invokes `cb` with the current
 * value. Returns an unsubscribe function.
 */
export function subscribePageEngagement(cb: EngagementListener): () => void {
  ensureListening();
  listeners.add(cb);
  const current = isPageEngaged();
  lastEmitted = current;
  cb(current);
  return () => {
    listeners.delete(cb);
    maybeStopListening();
  };
}

/** `useSyncExternalStore` subscribe — ignores the boolean payload. */
export function subscribePageEngagementStore(onStoreChange: () => void): () => void {
  return subscribePageEngagement(() => {
    onStoreChange();
  });
}

export function getPageEngagedSnapshot(): boolean {
  return isPageEngaged();
}

/** Server / SSR snapshot — never “reading” until hydrated in the browser. */
export function getServerPageEngagedSnapshot(): boolean {
  return false;
}

/** Test-only: reset module listeners / pagehide flag. */
export function __resetPageEngagementForTests(): void {
  pagehideAway = false;
  listeners.clear();
  lastEmitted = undefined;
  if (listening && browserAvailable()) {
    document.removeEventListener('visibilitychange', emit);
    window.removeEventListener('focus', emit);
    window.removeEventListener('blur', emit);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
  }
  listening = false;
}
