import { useEffect } from 'react';
import { SESSION_STORAGE_KEY } from '../lib/auth-utils';

const BROADCAST_CHANNEL_NAME = 'mysocial-auth';

function extractSubFromJwt(jwt: string): string | undefined {
  try {
    const parts = String(jwt).split('.');
    if (parts.length !== 3) return undefined;
    const payload = parts[1];
    if (!payload) return undefined;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const parsed = JSON.parse(atob(padded)) as { sub?: string };
    return parsed.sub;
  } catch {
    return undefined;
  }
}

export function MySocialAuthBroadcastListener({
  onSessionStored,
}: {
  onSessionStored?: () => void;
}) {
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;

    const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);

    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object' || data.type !== 'MYSOCIAL_AUTH_RESULT') return;

      const msg = data as {
        code: string;
        salt?: string;
        id_token?: string;
        access_token?: string;
        session_access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        user?: { address?: string; sub?: string; id?: string; email?: string };
      };

      const user = msg.user ?? {};
      let sub = user.sub ?? user.id ?? '';
      if (!sub && msg.id_token) {
        const subFromJwt = extractSubFromJwt(msg.id_token);
        if (subFromJwt) sub = subFromJwt;
      }

      const effectiveToken = msg.session_access_token ?? msg.access_token ?? msg.code;
      const resolvedAddress = user.address;
      if (!sub || !effectiveToken || !resolvedAddress) {
        console.error('[MySocialAuth] Invalid broadcast session payload');
        return;
      }

      const expiresAt =
        msg.expires_in != null ? Date.now() + msg.expires_in * 1000 : Date.now() + 3600_000;

      const session = {
        access_token: effectiveToken,
        ...(msg.session_access_token && { session_access_token: msg.session_access_token }),
        refresh_token: msg.refresh_token ?? undefined,
        ...(msg.id_token && { id_token: msg.id_token }),
        sub,
        user: { ...user, address: resolvedAddress, sub },
        expires_at: expiresAt,
        ...(msg.salt && { salt: msg.salt }),
      };

      try {
        sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
        window.dispatchEvent(new CustomEvent('mysocial-auth-broadcast-session'));
        onSessionStored?.();
      } catch (err) {
        console.error('Failed to store broadcast auth session:', err);
      }
    };

    channel.addEventListener('message', handler);
    return () => {
      channel.removeEventListener('message', handler);
      channel.close();
    };
  }, [onSessionStored]);

  return null;
}
