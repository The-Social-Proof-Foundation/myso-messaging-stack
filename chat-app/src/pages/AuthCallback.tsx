import { useEffect, useState } from 'react';
import type { AuthResultMessage } from '../lib/auth-session-build';
import {
  buildSessionFromAuthResult,
  SESSION_CANNOT_REFRESH_MESSAGE,
  sessionLacksRefreshToken,
} from '../lib/auth-session-build';
import { getMySocialAuth } from '../lib/mysocial-auth-client';

async function handlePopupFallback(): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('_popup_fallback') !== '1') return false;

  const hashParams = new URLSearchParams((window.location.hash || '').slice(1));
  const channel = new BroadcastChannel('mysocial-auth');

  const errorParam = params.get('error');
  if (errorParam) {
    channel.postMessage({
      type: 'MYSOCIAL_AUTH_ERROR',
      error: errorParam,
      state: params.get('state') || '',
    });
    channel.close();
    window.close();
    return true;
  }

  const code = params.get('code');
  const state = params.get('state');
  const nonce = params.get('nonce');
  const clientId = params.get('clientId');
  if (!code || !state || !nonce || !clientId) {
    channel.postMessage({
      type: 'MYSOCIAL_AUTH_ERROR',
      error: 'Missing required auth params',
      state: state || '',
    });
    channel.close();
    window.close();
    return true;
  }

  let user: { address?: string; sub?: string } = {};
  if (params.get('address')) user.address = params.get('address') || undefined;
  if (params.get('sub')) user.sub = params.get('sub') || undefined;

  const authResult: AuthResultMessage = {
    code,
    salt: params.get('salt') || undefined,
    id_token: hashParams.get('id_token') ?? params.get('id_token') ?? undefined,
    access_token:
      hashParams.get('access_token') ?? params.get('access_token') ?? undefined,
    session_access_token:
      hashParams.get('session_access_token') ??
      params.get('session_access_token') ??
      undefined,
    refresh_token:
      hashParams.get('refresh_token') ?? params.get('refresh_token') ?? undefined,
    expires_in: hashParams.get('expires_in')
      ? Number(hashParams.get('expires_in'))
      : params.get('expires_in')
        ? Number(params.get('expires_in'))
        : undefined,
    user: Object.keys(user).length > 0 ? user : undefined,
  };

  // Validate payload shape before broadcasting (main window stores via listener)
  if (!buildSessionFromAuthResult(authResult)) {
    channel.postMessage({
      type: 'MYSOCIAL_AUTH_ERROR',
      error: 'Invalid auth result payload',
      state: state || '',
    });
    channel.close();
    window.close();
    return true;
  }

  channel.postMessage({
    type: 'MYSOCIAL_AUTH_RESULT',
    ...authResult,
    state,
    nonce,
    clientId,
  });
  channel.close();
  window.close();
  return true;
}

export default function AuthCallback() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (await handlePopupFallback()) return;

      const auth = getMySocialAuth();
      if (!auth) {
        if (!cancelled) setError('MySocial auth is not configured.');
        return;
      }

      try {
        const session = await auth.handleRedirectCallback();
        if (sessionLacksRefreshToken(session)) {
          console.warn(
            '[MySocialAuth] Redirect session has no refresh_token; access JWT will expire in ~30 minutes without renewing.',
          );
          if (!cancelled) {
            setError(SESSION_CANNOT_REFRESH_MESSAGE);
            return;
          }
        }
        window.dispatchEvent(new CustomEvent('mysocial-auth-session-changed'));
        if (cancelled) return;
        window.location.replace('/');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Authentication callback failed.');
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-danger-500 dark:text-danger-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <p className="text-sm text-secondary-500 dark:text-secondary-400">Completing sign-in…</p>
    </div>
  );
}

export { SESSION_KEY as SESSION_STORAGE_KEY } from '../lib/mysocial-auth-storage';
