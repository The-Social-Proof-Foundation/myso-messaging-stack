import { WALLET_ONLY_ACCESS_TOKEN, type Session } from '@socialproof/mysocial-auth';

export function isStockSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  }
  if (
    /Macintosh/i.test(ua) &&
    /Safari/i.test(ua) &&
    !/Chrome|Chromium|Edg\/|OPR\/|Firefox/i.test(ua)
  ) {
    return true;
  }
  const vendor = navigator.vendor || '';
  if (!/Apple/i.test(vendor)) return false;
  if (!/Safari/i.test(ua)) return false;
  if (/Chrome|CriOS|Chromium|EdgiOS|Edg\/|OPiOS|OPR\/|FxiOS/i.test(ua)) return false;
  return true;
}

export function shouldUseRedirectAuth(): boolean {
  if (typeof window === 'undefined') return true;
  const ua = navigator.userAgent || '';
  const nav = navigator as { userAgentData?: { mobile?: boolean } };
  const isMobile =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua) ||
    nav.userAgentData?.mobile === true;

  if (isStockSafari() && !isMobile) return false;
  if (isMobile) return true;
  if (window.matchMedia?.('(pointer: coarse)')?.matches) return true;

  const isChrome = /Chrome/.test(ua) && !/Edge|Edg|OPR/.test(ua);
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium/.test(ua);
  const isFirefox = /Firefox/.test(ua);
  const isEdge = /Edge|Edg/.test(ua);
  return !(isChrome || isSafari || isFirefox || isEdge);
}

function decodeJwtPayload(accessToken: string): Record<string, unknown> | null {
  try {
    const parts = String(accessToken).split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isJwtShape(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  const parts = value.trim().split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function isWalletSessionSub(sub: string | null | undefined): boolean {
  return Boolean(sub?.toString().trim().startsWith('wallet:'));
}

function isCompositeUserIdentifierSub(sub: string): boolean {
  return sub.includes('://') || (sub.includes(':') && !sub.startsWith('0x'));
}

/** Prefer Google/provider id_token.sub for wallet derivation. */
export function resolveOAuthSubForKeypair(session: Session): string {
  const user = session.user ?? {};
  const idToken = session.id_token;
  if (idToken) {
    const idTokenSub = decodeJwtPayload(idToken)?.sub as string | undefined;
    const value = idTokenSub?.toString().trim();
    if (value && !isWalletSessionSub(value) && !isCompositeUserIdentifierSub(value)) {
      return value;
    }
  }

  const accessToken = session.access_token;
  if (accessToken && isJwtShape(accessToken)) {
    const accessSub = decodeJwtPayload(accessToken)?.sub as string | undefined;
    const value = accessSub?.toString().trim();
    if (value && !isWalletSessionSub(value) && !isCompositeUserIdentifierSub(value)) {
      return value;
    }
  }

  for (const candidate of [user.sub, user.id, session.sub]) {
    const value = candidate?.toString().trim();
    if (value && !isWalletSessionSub(value) && !isCompositeUserIdentifierSub(value)) {
      return value;
    }
  }

  return '';
}

export const SESSION_STORAGE_KEY = 'mysocial_auth_session';

/** Create/import wallet flow — not OAuth Google/Apple sign-in. */
export function isTrueWalletOnlySession(session: Session): boolean {
  return session.access_token === WALLET_ONLY_ACCESS_TOKEN;
}

/** OAuth session can derive a signing key without session_access_token when salt/id_token are present. */
export function canAttemptOAuthKeypairDerivation(session: Session): boolean {
  if (isTrueWalletOnlySession(session)) return false;
  if (session.salt?.trim() || session.id_token?.trim()) return true;
  if (session.user?.address && resolveOAuthSubForKeypair(session)) return true;
  return Boolean(session.session_access_token || session.refresh_token);
}
