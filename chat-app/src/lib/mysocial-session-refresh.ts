import type { AuthUser, Session } from '@socialproof/mysocial-auth';
import { getAuthSessionRaw, removeAuthSession, setAuthSessionRaw } from './mysocial-auth-storage';

/** Same event the auth context already listens for. */
const SESSION_CHANGED_EVENT = 'mysocial-auth-session-changed';

/** Refresh this long before the session JWT actually expires. */
export const AUTH_SESSION_REFRESH_BUFFER_MS = 2 * 60 * 1000;

const TRANSIENT_RETRY_MS = 5_000;

export type AuthSessionRefreshResult =
  | { status: 'none' }
  | { status: 'fresh'; expiresAt: number }
  | {
      status: 'refreshed';
      expiresAt: number;
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    }
  | { status: 'transient'; retryAfterMs: number }
  | { status: 'revoked' };

type RefreshBody = {
  access_token?: string;
  session_access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  user?: AuthUser;
};

let inFlight: Promise<AuthSessionRefreshResult> | null = null;
let sessionRevoked = false;

export function delayUntilAuthSessionRefresh(expiresAt: number): number {
  return Math.max(0, expiresAt - Date.now() - AUTH_SESSION_REFRESH_BUFFER_MS);
}

/** True once after a refresh token is rejected. Cleared on read. */
export function consumeAuthSessionRevoked(): boolean {
  const revoked = sessionRevoked;
  sessionRevoked = false;
  return revoked;
}

export function readStoredAuthSession(): Session | null {
  const raw = getAuthSessionRaw();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    const accessToken = parsed.access_token || parsed.session_access_token;
    if (!accessToken) return null;
    const user = parsed.user ?? {};
    return {
      ...parsed,
      access_token: accessToken,
      session_access_token: parsed.session_access_token,
      refresh_token: parsed.refresh_token,
      id_token: parsed.id_token,
      expires_at: typeof parsed.expires_at === 'number' ? parsed.expires_at : 0,
      sub: parsed.sub || user.sub || user.id || '',
      user,
      salt: parsed.salt,
    };
  } catch {
    return null;
  }
}

function saltRefreshUrl(): string | null {
  const base = import.meta.env.VITE_MYSOCIAL_AUTH_API_BASE_URL;
  if (typeof base !== 'string' || !base.trim()) return null;
  return `${base.trim().replace(/\/+$/, '')}/auth/refresh`;
}

function jwtExpiryMs(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return undefined;
    return payload.exp * 1000;
  } catch {
    return undefined;
  }
}

function effectiveExpiryMs(session: Session): number {
  const jwtMs = jwtExpiryMs(session.session_access_token || session.access_token);
  const stored =
    Number.isFinite(session.expires_at) && session.expires_at > 0 ? session.expires_at : undefined;
  if (jwtMs != null && stored != null) return Math.min(stored, jwtMs);
  return jwtMs ?? stored ?? 0;
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get('retry-after');
  if (!header) return TRANSIENT_RETRY_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(seconds * 1000, 1_000), 60_000);
  }
  const when = Date.parse(header);
  if (Number.isFinite(when)) {
    return Math.min(Math.max(when - Date.now(), 1_000), 60_000);
  }
  return TRANSIENT_RETRY_MS;
}

function mergeUser(existing: AuthUser | undefined, incoming: AuthUser | undefined): AuthUser {
  const user = { ...(existing ?? {}) };
  const address = typeof incoming?.address === 'string' ? incoming.address.trim() : '';
  if (address) user.address = address;
  return user;
}

function notifySessionChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SESSION_CHANGED_EVENT));
}

function transient(retryAfter = TRANSIENT_RETRY_MS): AuthSessionRefreshResult {
  return { status: 'transient', retryAfterMs: retryAfter };
}

async function rotate(session: Session): Promise<AuthSessionRefreshResult> {
  const refreshToken = session.refresh_token;
  const url = saltRefreshUrl();
  if (!refreshToken || !url) return { status: 'none' };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch (error) {
    console.warn('[MySocialAuth] Session refresh failed; keeping the current session.', error);
    return transient();
  }

  if (response.status === 401) {
    sessionRevoked = true;
    removeAuthSession();
    return { status: 'revoked' };
  }

  if (response.status === 429) {
    console.warn('[MySocialAuth] Session refresh was rate limited; keeping the current session.');
    return transient(retryAfterMs(response));
  }

  if (!response.ok) {
    console.warn('[MySocialAuth] Session refresh failed; keeping the current session.', response.status);
    return transient();
  }

  let body: RefreshBody;
  try {
    body = (await response.json()) as RefreshBody;
  } catch (error) {
    console.warn(
      '[MySocialAuth] Session refresh returned an unreadable body; keeping the current session.',
      error,
    );
    return transient();
  }

  const accessToken = body.session_access_token || body.access_token;
  if (!accessToken || !body.refresh_token || typeof body.expires_in !== 'number' || body.expires_in <= 0) {
    console.warn('[MySocialAuth] Session refresh response was missing tokens; keeping the current session.');
    return transient();
  }

  const expiresAt = Date.now() + body.expires_in * 1000;
  const jwtMs = jwtExpiryMs(accessToken);
  const latest = readStoredAuthSession() ?? session;
  const next: Session = {
    ...latest,
    access_token: accessToken,
    session_access_token: accessToken,
    refresh_token: body.refresh_token,
    id_token: body.id_token ?? latest.id_token,
    expires_at: jwtMs != null ? Math.min(expiresAt, jwtMs) : expiresAt,
    sub: latest.sub || session.sub,
    user: mergeUser(latest.user, body.user),
    salt: latest.salt ?? session.salt,
  };
  setAuthSessionRaw(JSON.stringify(next));
  return {
    status: 'refreshed',
    expiresAt: next.expires_at,
    accessToken,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
  };
}

const ZK_PROOF_KEY = 'mysocial_zklogin_proving';

/** The zk proof writes the wallet address after OAuth. A refresh in that window would drop it. */
function zkProofBlockingRefresh(): boolean {
  try {
    return sessionStorage.getItem(ZK_PROOF_KEY) === '1';
  } catch {
    return false;
  }
}

/** Rotate the refresh token immediately. Shares one in-flight request with the keepalive. */
export function refreshAuthSessionNow(): Promise<AuthSessionRefreshResult> {
  if (zkProofBlockingRefresh()) {
    const session = readStoredAuthSession();
    return Promise.resolve({ status: 'fresh', expiresAt: session ? effectiveExpiryMs(session) : 0 });
  }
  if (inFlight) return inFlight;
  const session = readStoredAuthSession();
  if (!session?.refresh_token) return Promise.resolve({ status: 'none' });

  const pending = rotate(session).finally(() => {
    inFlight = null;
  });
  inFlight = pending;
  void pending.then((result) => {
    if (result.status === 'refreshed' || result.status === 'revoked') notifySessionChanged();
  });
  return pending;
}

/** Refresh only when the session JWT is expired or inside the 2-minute buffer. */
export function refreshAuthSessionIfNeeded(): Promise<AuthSessionRefreshResult> {
  if (inFlight) return inFlight;
  const session = readStoredAuthSession();
  if (!session?.refresh_token) return Promise.resolve({ status: 'none' });
  const expiresAt = effectiveExpiryMs(session);
  if (expiresAt - Date.now() >= AUTH_SESSION_REFRESH_BUFFER_MS) {
    return Promise.resolve({ status: 'fresh', expiresAt });
  }
  return refreshAuthSessionNow();
}
