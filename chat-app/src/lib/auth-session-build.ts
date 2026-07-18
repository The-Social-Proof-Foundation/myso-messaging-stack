import type { Session } from '@socialproof/mysocial-auth';
import {
  isTrueWalletOnlySession,
  resolveOAuthSubForKeypair,
} from './auth-utils';
import {
  getMySocialAuth,
  resetMySocialAuthInstance,
} from './mysocial-auth-client';
import { setAuthSessionRaw } from './mysocial-auth-storage';

/** Shape of MYSOCIAL_AUTH_RESULT from BroadcastChannel / popup fallback. */
export type AuthResultMessage = {
  code: string;
  salt?: string;
  id_token?: string;
  access_token?: string;
  session_access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { address?: string; sub?: string; id?: string; email?: string };
};

export const SESSION_CANNOT_REFRESH_MESSAGE =
  'Session cannot be refreshed — sign in again';

/** OAuth sessions need a refresh_token for ~30-day continuity (access JWT is ~30 min). */
export function sessionLacksRefreshToken(session: Session | null | undefined): boolean {
  if (!session) return false;
  if (isTrueWalletOnlySession(session)) return false;
  return !session.refresh_token?.trim();
}

/**
 * Build a Session matching the SDK shape from a MYSOCIAL_AUTH_RESULT payload.
 * Returns null if required fields (sub, token, address) are missing.
 */
export function buildSessionFromAuthResult(
  msg: AuthResultMessage,
): Session | null {
  const user = { ...(msg.user ?? {}) };
  const effectiveToken =
    msg.session_access_token ?? msg.access_token ?? msg.code;

  const expiresAt =
    msg.expires_in != null
      ? Date.now() + msg.expires_in * 1000
      : Date.now() + 3600_000;

  const draft: Session = {
    access_token: effectiveToken,
    ...(msg.session_access_token && {
      session_access_token: msg.session_access_token,
    }),
    refresh_token: msg.refresh_token ?? undefined,
    ...(msg.id_token && { id_token: msg.id_token }),
    sub: '',
    user,
    expires_at: expiresAt,
    ...(msg.salt && { salt: msg.salt }),
  };

  const sub = resolveOAuthSubForKeypair(draft);
  const resolvedAddress = user.address;
  if (!sub || !effectiveToken || !resolvedAddress) {
    return null;
  }

  user.sub = sub;
  return {
    ...draft,
    sub,
    user: { ...user, address: resolvedAddress, sub },
  };
}

/**
 * Persist session to shared localStorage, sync the singleton client, and notify React.
 * Returns true if the session was stored.
 */
export function storeBroadcastAuthSession(msg: AuthResultMessage): boolean {
  const session = buildSessionFromAuthResult(msg);
  if (!session) {
    console.error('[MySocialAuth] Invalid broadcast session payload');
    return false;
  }

  if (sessionLacksRefreshToken(session)) {
    console.warn(
      '[MySocialAuth] Broadcast session has no refresh_token; access JWT will expire in ~30 minutes without renewing.',
    );
  }

  try {
    setAuthSessionRaw(JSON.stringify(session));
    // Bypass stale in-memory SDK cache after out-of-band storage write.
    resetMySocialAuthInstance();
    void getMySocialAuth()?.getSession();
    window.dispatchEvent(new CustomEvent('mysocial-auth-broadcast-session'));
    return true;
  } catch (err) {
    console.error('Failed to store broadcast auth session:', err);
    return false;
  }
}
