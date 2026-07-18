import {
  createMySocialAuth,
  type MySocialAuth,
} from '@socialproof/mysocial-auth';
import { readMySocialAuthConfig } from './mysocial-auth-config';

let authInstance: MySocialAuth | null = null;
let initAttempted = false;
let initError: string | null = null;

/**
 * Single shared MySocial auth client for the app lifetime.
 * Avoids concurrent /auth/refresh races from multiple createMySocialAuth() instances
 * (StrictMode remounts, AuthCallback vs provider).
 */
export function getMySocialAuth(): MySocialAuth | null {
  if (authInstance) return authInstance;
  if (initAttempted) return null;

  initAttempted = true;
  const { config, error } = readMySocialAuthConfig();
  if (!config) {
    initError = error;
    return null;
  }

  authInstance = createMySocialAuth(config);
  return authInstance;
}

/** Config error from the last getMySocialAuth() attempt (null if OK or not yet tried). */
export function getMySocialAuthConfigError(): string | null {
  if (!initAttempted) {
    const { error } = readMySocialAuthConfig();
    return error;
  }
  return initError;
}

/** Reset singleton (tests). Does not clear sessionStorage. */
export function resetMySocialAuthInstance(): void {
  authInstance = null;
  initAttempted = false;
  initError = null;
}
