/**
 * User-facing copy for MLS (forward secrecy) states (E2EE M6). Never shows an empty thread for an
 * `mls1` group this tab can't read: says why instead.
 */

import { MlsGroupUnavailableError, MlsMembersUnverifiedError } from '@socialproof/myso-messaging-stack';

import { mlsTabState } from './mls-runtime';

/** Copy for an MLS error, or `null` when `err` isn't one. */
export function mlsErrorMessage(err: unknown): string | null {
  if (err instanceof MlsMembersUnverifiedError) {
    return "A member's device is still being verified, so your message wasn't sent. It will go through once verification finishes — try again in a moment.";
  }
  if (!(err instanceof MlsGroupUnavailableError)) return null;
  if (err.reason === 'removed') return 'You are no longer a member of this chat.';
  if (err.reason === 'not-joined') {
    return 'Setting up end-to-end encryption for this chat on this device… This usually takes a few seconds.';
  }
  switch (mlsTabState()) {
    case 'waiting':
      return 'This chat is open in another tab. Close that tab (or use it) to read it here.';
    case 'starting':
      return 'Starting end-to-end encryption…';
    case 'off':
      return 'This chat uses newer end-to-end encryption. Update the app to read it.';
    default:
      return "End-to-end encryption couldn't start on this device. Reload to try again.";
  }
}

/** Retry `run` while it fails only because member devices are still being verified. */
export async function withMlsVerificationRetry<T>(run: () => Promise<T>, delaysMs = [1_500, 4_000, 10_000]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof MlsMembersUnverifiedError) || attempt >= delaysMs.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}
