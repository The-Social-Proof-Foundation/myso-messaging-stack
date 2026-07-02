import { useEffect, useState } from 'react';
import { createMySocialAuth } from '@socialproof/mysocial-auth';
import { SESSION_STORAGE_KEY } from '../lib/auth-utils';

function readAuthConfig(): Parameters<typeof createMySocialAuth>[0] | null {
  const apiBaseUrl = import.meta.env.VITE_MYSOCIAL_AUTH_API_BASE_URL;
  const authOrigin = import.meta.env.VITE_MYSOCIAL_AUTH_ORIGIN;
  const clientId = import.meta.env.VITE_MYSOCIAL_AUTH_CLIENT_ID;
  const redirectUri = import.meta.env.VITE_MYSOCIAL_AUTH_REDIRECT_URI;
  if (!apiBaseUrl || !authOrigin || !clientId || !redirectUri) return null;
  return {
    apiBaseUrl,
    authOrigin,
    clientId,
    redirectUri,
    storage: 'session',
    proactiveRefresh: true,
  };
}

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

  channel.postMessage({
    type: 'MYSOCIAL_AUTH_RESULT',
    code,
    salt: params.get('salt') || undefined,
    id_token: hashParams.get('id_token') ?? params.get('id_token') ?? undefined,
    access_token: hashParams.get('access_token') ?? params.get('access_token') ?? undefined,
    session_access_token:
      hashParams.get('session_access_token') ?? params.get('session_access_token') ?? undefined,
    refresh_token: hashParams.get('refresh_token') ?? params.get('refresh_token') ?? undefined,
    expires_in: hashParams.get('expires_in')
      ? Number(hashParams.get('expires_in'))
      : params.get('expires_in')
        ? Number(params.get('expires_in'))
        : undefined,
    user: Object.keys(user).length > 0 ? user : undefined,
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

      const config = readAuthConfig();
      if (!config) {
        if (!cancelled) setError('MySocial auth is not configured.');
        return;
      }

      try {
        const auth = createMySocialAuth(config);
        await auth.handleRedirectCallback();
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

export { SESSION_STORAGE_KEY };
