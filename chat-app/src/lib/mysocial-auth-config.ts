import type { MySocialAuthConfig } from '@socialproof/mysocial-auth';
import { createLocalStorageAdapter } from './mysocial-auth-storage';

export type ReadMySocialAuthConfigResult = {
  config: MySocialAuthConfig | null;
  error: string | null;
};

function originHost(url: string): string | null {
  try {
    return new URL(url.trim()).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Read Vite env into createMySocialAuth config.
 * apiBaseUrl = salt service origin (/auth/refresh, /auth/logout) — must allow browser CORS.
 * authOrigin = OAuth UI host only (not used for refresh).
 */
export function readMySocialAuthConfig(): ReadMySocialAuthConfigResult {
  const apiBaseUrl = import.meta.env.VITE_MYSOCIAL_AUTH_API_BASE_URL;
  const authOrigin = import.meta.env.VITE_MYSOCIAL_AUTH_ORIGIN;
  const clientId = import.meta.env.VITE_MYSOCIAL_AUTH_CLIENT_ID;
  const redirectUri = import.meta.env.VITE_MYSOCIAL_AUTH_REDIRECT_URI;

  if (
    typeof apiBaseUrl !== 'string' ||
    typeof authOrigin !== 'string' ||
    typeof clientId !== 'string' ||
    typeof redirectUri !== 'string' ||
    !apiBaseUrl ||
    !authOrigin ||
    !clientId ||
    !redirectUri
  ) {
    const prodHint = import.meta.env.PROD
      ? ' Preview/production bundles read env only at build time. Run vite build again after changing .env.'
      : '';
    return {
      config: null,
      error:
        'Missing MySocial auth env: VITE_MYSOCIAL_AUTH_API_BASE_URL, VITE_MYSOCIAL_AUTH_ORIGIN, VITE_MYSOCIAL_AUTH_CLIENT_ID, VITE_MYSOCIAL_AUTH_REDIRECT_URI.' +
        prodHint,
    };
  }

  // Common misconfig: apiBaseUrl = authOrigin → CORS blocks /auth/refresh from localhost.
  const apiHost = originHost(apiBaseUrl);
  const authHost = originHost(authOrigin);
  if (apiHost && authHost && apiHost === authHost) {
    console.warn(
      '[mysocial-auth] VITE_MYSOCIAL_AUTH_API_BASE_URL matches AUTH_ORIGIN (' +
        apiHost +
        '). Refresh/logout must use the salt service (e.g. https://salt.testnet.mysocial.network), ' +
        'not the auth UI host — otherwise browser CORS fails and sessions die at JWT expiry.',
    );
  }

  return {
    config: {
      apiBaseUrl: apiBaseUrl.trim().replace(/\/+$/, ''),
      authOrigin: authOrigin.trim().replace(/\/+$/, ''),
      clientId,
      redirectUri,
      storage: createLocalStorageAdapter(),
      // App owns proactive refresh in MySocialAuthContext — SDK timers leak across
      // resetMySocialAuthInstance() and can race /auth/refresh (SessionRevoked).
      proactiveRefresh: false,
    },
    error: null,
  };
}
