/**
 * Logout / identity-clear hook: close relayer WebSockets so the presence
 * registry broadcasts offline, even if the user stays on the sign-in page.
 */

type TeardownFn = () => void | Promise<void>;

let teardownFn: TeardownFn | null = null;

export function registerMessagingPresenceTeardown(fn: TeardownFn | null): void {
  teardownFn = fn;
}

/** Best-effort: mark inactive + disconnect transports. Safe to call when idle. */
export async function teardownMessagingPresence(): Promise<void> {
  const fn = teardownFn;
  if (!fn) return;
  try {
    await fn();
  } catch (err) {
    console.warn('[chat-app] messaging presence teardown failed:', err);
  }
}
