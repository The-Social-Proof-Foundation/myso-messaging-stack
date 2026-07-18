import type { MySocialAuthConfig } from '@socialproof/mysocial-auth';

export type ReadMySocialAuthConfigResult = {
  config: MySocialAuthConfig | null;
  error: string | null;
};

/**
 * Read Vite env into createMySocialAuth config.
 * apiBaseUrl = salt service origin (/auth/refresh, /auth/logout).
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

  return {
    config: {
      apiBaseUrl,
      authOrigin,
      clientId,
      redirectUri,
      storage: 'session',
      proactiveRefresh: true,
    },
    error: null,
  };
}
