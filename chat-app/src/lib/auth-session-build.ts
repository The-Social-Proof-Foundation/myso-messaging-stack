import type { Session } from '@socialproof/mysocial-auth';
import {
  isTrueWalletOnlySession,
  resolveOAuthSubForKeypair,
} from './auth-utils';
import {
  getMySocialAuth,
  resetMySocialAuthInstance,
} from './mysocial-auth-client';
import { removeAuthSession, setAuthSessionRaw } from './mysocial-auth-storage';

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

/** Match @socialproof/mysocial-auth REFRESH_BUFFER_MS (refresh ~2 min before expiry). */
export const REFRESH_BUFFER_MS = 120_000;

/** OAuth sessions need a refresh_token for ~30-day continuity (access JWT is ~30 min). */
export function sessionLacksRefreshToken(session: Session | null | undefined): boolean {
  if (!session) return false;
  if (isTrueWalletOnlySession(session)) return false;
  return !session.refresh_token?.trim();
}

function decodeJwtExpMs(jwt: string | undefined): number | undefined {
  if (!jwt?.trim()) return undefined;
  try {
    const parts = jwt.trim().split('.');
    if (parts.length !== 3 || !parts[1]) return undefined;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      '=',
    );
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      return undefined;
    }
    return payload.exp * 1000;
  } catch {
    return undefined;
  }
}

/**
 * Earliest of session.expires_at and session_access_token JWT exp (when decodable).
 * Aligns app proactive refresh with SDK getSession() behavior.
 */
export function getEffectiveExpiryMs(session: Session): number {
  const jwtMs = decodeJwtExpMs(session.session_access_token);
  if (jwtMs != null) return Math.min(session.expires_at, jwtMs);
  return session.expires_at;
}

/** Delay until we should call getSession() to renew (clamped ≥ 0). */
export function msUntilProactiveRefresh(session: Session): number {
  return Math.max(0, getEffectiveExpiryMs(session) - Date.now() - REFRESH_BUFFER_MS);
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
    console.error(
      '[MySocialAuth] Broadcast session has no refresh_token; refusing to persist.',
    );
    return false;
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

/** Clear a non-refreshable OAuth session from storage (and notify SDK if present). */
export async function rejectNonRefreshableSession(
  session: Session | null | undefined,
): Promise<boolean> {
  if (!sessionLacksRefreshToken(session)) return false;
  const auth = getMySocialAuth();
  try {
    if (auth) {
      await auth.signOut();
    }
  } catch {
    // ignore remote logout failures
  } finally {
    removeAuthSession();
  }
  return true;
}
