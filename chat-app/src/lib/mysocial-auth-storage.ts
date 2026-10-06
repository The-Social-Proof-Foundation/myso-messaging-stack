/**
 * Shared MySocial Auth session storage (localStorage).
 * Cross-tab: new tabs and open tabs can read the same session.
 * PKCE/redirect state stays in sessionStorage via the SDK's redirectStorage.
 */

export const SESSION_KEY = 'mysocial_auth_session';

/** Alias for older call sites. */
export const SESSION_STORAGE_KEY = SESSION_KEY;

export type StorageAdapter = {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
};

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function canUseSessionStorage(): boolean {
  return typeof window !== 'undefined' && typeof sessionStorage !== 'undefined';
}

/** One-time migrate per-tab sessionStorage → shared localStorage. */
function migrateSessionStorageIfNeeded(key: string): string | null {
  if (!canUseSessionStorage()) return null;
  try {
    const legacy = sessionStorage.getItem(key);
    if (!legacy) return null;
    if (canUseLocalStorage()) {
      try {
        if (!localStorage.getItem(key)) {
          localStorage.setItem(key, legacy);
        }
      } catch {
        // ignore quota / private mode
      }
    }
    sessionStorage.removeItem(key);
    return canUseLocalStorage() ? localStorage.getItem(key) : legacy;
  } catch {
    return null;
  }
}

function readLocal(key: string): string | null {
  if (!canUseLocalStorage()) return null;
  try {
    const value = localStorage.getItem(key);
    if (value != null) return value;
    return migrateSessionStorageIfNeeded(key);
  } catch {
    return migrateSessionStorageIfNeeded(key);
  }
}

function writeLocal(key: string, value: string): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
  if (canUseSessionStorage()) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
}

function removeLocal(key: string): void {
  if (canUseLocalStorage()) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
  if (canUseSessionStorage()) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
}

/** SDK StorageAdapter backed by localStorage (with sessionStorage migration). */
export function createLocalStorageAdapter(): StorageAdapter {
  return {
    get: (key) => readLocal(key),
    set: (key, value) => writeLocal(key, value),
    remove: (key) => removeLocal(key),
  };
}

export function getAuthSessionRaw(): string | null {
  return readLocal(SESSION_KEY);
}

export function setAuthSessionRaw(value: string): void {
  writeLocal(SESSION_KEY, value);
}

export function removeAuthSession(): void {
  removeLocal(SESSION_KEY);
}

export function hasAuthSession(): boolean {
  return !!getAuthSessionRaw();
}

/** Set when Sign In starts. Survives the OAuth redirect, then the next page consumes it. */
const LOGIN_CELEBRATION_KEY = 'myso-login-celebration';

export function markLoginCelebration(): void {
  if (!canUseSessionStorage()) return;
  try {
    sessionStorage.setItem(LOGIN_CELEBRATION_KEY, '1');
  } catch {
    // ignore quota / private mode
  }
}

export function clearLoginCelebration(): void {
  if (!canUseSessionStorage()) return;
  try {
    sessionStorage.removeItem(LOGIN_CELEBRATION_KEY);
  } catch {
    // ignore
  }
}

/** True when Sign In has started and this document has not finished the ceremony. */
export function peekLoginCelebration(): boolean {
  if (!canUseSessionStorage()) return false;
  try {
    return sessionStorage.getItem(LOGIN_CELEBRATION_KEY) === '1';
  } catch {
    return false;
  }
}
