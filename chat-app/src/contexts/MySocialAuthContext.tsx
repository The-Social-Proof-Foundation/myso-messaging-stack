import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  SessionRevokedError,
  type MySocialAuth,
  type Session,
} from '@socialproof/mysocial-auth';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import {
  msUntilProactiveRefresh,
  rejectNonRefreshableSession,
  SESSION_CANNOT_REFRESH_MESSAGE,
  sessionLacksRefreshToken,
} from '../lib/auth-session-build';
import { deriveKeypairFromSubAndSalt } from '../lib/derive-mysocial-keypair';
import { getOrCreateDevMessengerKeypair } from '../lib/dev-signer';
import { getSaltFromSession } from '../lib/get-salt-from-session';
import {
  getMySocialAuth,
  getMySocialAuthConfigError,
  resetMySocialAuthInstance,
} from '../lib/mysocial-auth-client';
import { teardownMessagingPresence } from '../lib/messaging-presence-teardown';
import {
  getAuthSessionRaw,
  removeAuthSession,
  SESSION_KEY,
  setAuthSessionRaw,
} from '../lib/mysocial-auth-storage';
import {
  canAttemptOAuthKeypairDerivation,
  isTrueWalletOnlySession,
  resolveOAuthSubForKeypair,
  shouldUseRedirectAuth,
} from '../lib/auth-utils';

const SESSION_EXPIRED_MESSAGE =
  'Session expired — please sign in again';

function applyRefreshTokenGuard(
  s: Session | null,
  setSignInError: (msg: string | null) => void,
): void {
  if (sessionLacksRefreshToken(s)) {
    console.warn(
      '[MySocialAuth] Session has no refresh_token; rejecting non-refreshable OAuth session.',
    );
    setSignInError(SESSION_CANNOT_REFRESH_MESSAGE);
  }
}

function isSessionRevokedOrExpiredError(e: unknown): boolean {
  if (e instanceof SessionRevokedError) return true;
  const message = e instanceof Error ? e.message : String(e);
  return /session revoked|session expired|401|unauthorized|invalid.*refresh/i.test(
    message,
  );
}

function devUnblockEnabled(): boolean {
  const v = import.meta.env.VITE_DEV_UNBLOCK_MESSAGING_UI;
  return v === 'true' || v === '1' || v === 'yes';
}

function applyDevSigner(
  setKeypair: (kp: Ed25519Keypair) => void,
  setIsUsingDevMessengerSigner: (v: boolean) => void,
  setDeriveKeyError: (v: string | null) => void,
  setDerivingKeypair: (v: boolean) => void,
): void {
  setKeypair(getOrCreateDevMessengerKeypair());
  setIsUsingDevMessengerSigner(true);
  setDeriveKeyError(null);
  setDerivingKeypair(false);
}

interface MySocialAuthContextValue {
  auth: MySocialAuth | null;
  session: Session | null;
  keypair: Ed25519Keypair | null;
  isUsingDevMessengerSigner: boolean;
  walletOnlyBlocked: boolean;
  deriveKeyError: string | null;
  derivingKeypair: boolean;
  configError: string | null;
  signInError: string | null;
  login: () => void;
  logout: () => Promise<void>;
  connectedAddress: string | undefined;
  retryKeypairDerivation: () => void;
}

const MySocialAuthContext = createContext<MySocialAuthContextValue | null>(null);

export function MySocialAuthProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const [auth, setAuth] = useState<MySocialAuth | null>(() => getMySocialAuth());
  const configErrorFromEnv = useMemo(() => getMySocialAuthConfigError(), []);

  const saltUrl =
    import.meta.env.VITE_MYSOCIAL_SALT_URL ||
    'https://salt.testnet.mysocial.network/salt';

  const [session, setSession] = useState<Session | null>(null);
  const [keypair, setKeypair] = useState<Ed25519Keypair | null>(null);
  const [isUsingDevMessengerSigner, setIsUsingDevMessengerSigner] =
    useState(false);
  const [deriveKeyError, setDeriveKeyError] = useState<string | null>(null);
  const [derivingKeypair, setDerivingKeypair] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [deriveNonce, setDeriveNonce] = useState(0);

  const authRef = useRef(auth);
  authRef.current = auth;

  const hadSessionRef = useRef(false);
  const proactiveRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const clearProactiveRefreshTimer = useCallback(() => {
    if (proactiveRefreshTimerRef.current != null) {
      clearTimeout(proactiveRefreshTimerRef.current);
      proactiveRefreshTimerRef.current = null;
    }
  }, []);

  const retryKeypairDerivation = useCallback(() => {
    setDeriveNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!auth) {
      setSession(null);
      clearProactiveRefreshTimer();
      return;
    }

    let cancelled = false;

    const applySession = (s: Session | null) => {
      if (cancelled) return;
      if (s && !sessionLacksRefreshToken(s)) {
        setSignInError(null);
      }
      applyRefreshTokenGuard(s, setSignInError);
      hadSessionRef.current = Boolean(s);
      setSession(s);
      setDeriveNonce((n) => n + 1);
    };

    const rebindToSingletonAndSync = () => {
      resetMySocialAuthInstance();
      const next = getMySocialAuth();
      authRef.current = next;
      setAuth(next);
      if (!next) {
        applySession(null);
        return;
      }
      // setAuth triggers this effect to re-subscribe; also sync immediately if
      // the singleton identity did not change (shouldn't happen after reset).
      void next.getSession().then(applySession);
    };

    const onBroadcastOrSessionChanged = () => {
      // Broadcast / redirect wrote storage out-of-band and may have reset the
      // singleton — rebind React to the live client so we do not listen to orphans.
      const next = getMySocialAuth();
      if (next !== auth) {
        authRef.current = next;
        setAuth(next);
        if (!next) {
          applySession(null);
          return;
        }
      }
      const current = next ?? auth;
      void current.getSession().then(applySession);
    };

    void auth.getSession().then(async (s) => {
      if (cancelled) return;
      if (await rejectNonRefreshableSession(s)) {
        applySession(null);
        setSignInError(SESSION_CANNOT_REFRESH_MESSAGE);
        return;
      }
      applySession(s);
    });

    const unsub = auth.onAuthStateChange((s) => {
      if (!s && hadSessionRef.current) {
        setSignInError(SESSION_EXPIRED_MESSAGE);
        setKeypair(null);
        setIsUsingDevMessengerSigner(false);
        setDeriveKeyError(null);
      } else if (s) {
        if (sessionLacksRefreshToken(s)) {
          void rejectNonRefreshableSession(s).then(() => {
            if (cancelled) return;
            setSignInError(SESSION_CANNOT_REFRESH_MESSAGE);
            hadSessionRef.current = false;
            setSession(null);
            setKeypair(null);
            setDeriveNonce((n) => n + 1);
          });
          return;
        }
        applyRefreshTokenGuard(s, setSignInError);
      }
      hadSessionRef.current = Boolean(s);
      setSession(s);
      setDeriveNonce((n) => n + 1);
    });

    window.addEventListener(
      'mysocial-auth-broadcast-session',
      onBroadcastOrSessionChanged,
    );
    window.addEventListener(
      'mysocial-auth-session-changed',
      onBroadcastOrSessionChanged,
    );

    const onStorage = (event: StorageEvent) => {
      if (event.key !== SESSION_KEY && event.key !== null) return;
      // Cross-tab logout: avoid "session expired" toast from hadSessionRef.
      if (event.newValue == null) {
        hadSessionRef.current = false;
        setSignInError(null);
      }
      rebindToSingletonAndSync();
    };
    window.addEventListener('storage', onStorage);

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      const current = getMySocialAuth() ?? auth;
      void current.getSession().then(applySession);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      unsub();
      clearProactiveRefreshTimer();
      window.removeEventListener(
        'mysocial-auth-broadcast-session',
        onBroadcastOrSessionChanged,
      );
      window.removeEventListener(
        'mysocial-auth-session-changed',
        onBroadcastOrSessionChanged,
      );
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [auth, clearProactiveRefreshTimer]);

  // Single app-owned proactive refresh (SDK proactiveRefresh is disabled).
  useEffect(() => {
    clearProactiveRefreshTimer();
    if (!auth || !session?.refresh_token?.trim()) return;

    const delay = msUntilProactiveRefresh(session);
    proactiveRefreshTimerRef.current = setTimeout(() => {
      proactiveRefreshTimerRef.current = null;
      const current = getMySocialAuth() ?? auth;
      void current.getSession().then((s) => {
        if (s && !sessionLacksRefreshToken(s)) {
          setSignInError(null);
        }
        applyRefreshTokenGuard(s, setSignInError);
        hadSessionRef.current = Boolean(s);
        setSession(s);
        if (s) setDeriveNonce((n) => n + 1);
      });
    }, delay);

    return () => {
      clearProactiveRefreshTimer();
    };
  }, [auth, session, clearProactiveRefreshTimer]);

  const walletOnlyBlocked = Boolean(
    session && isTrueWalletOnlySession(session) && !devUnblockEnabled(),
  );
  const connectedAddress = session?.user?.address;

  useEffect(() => {
    if (!auth) {
      setKeypair(null);
      setIsUsingDevMessengerSigner(false);
      setDeriveKeyError(null);
      setDerivingKeypair(false);
      return;
    }

    if (!session) {
      setKeypair(null);
      setIsUsingDevMessengerSigner(false);
      setDeriveKeyError(null);
      setDerivingKeypair(false);
      return;
    }

    if (isTrueWalletOnlySession(session)) {
      if (devUnblockEnabled()) {
        applyDevSigner(
          setKeypair,
          setIsUsingDevMessengerSigner,
          setDeriveKeyError,
          setDerivingKeypair,
        );
        return;
      }
      setKeypair(null);
      setIsUsingDevMessengerSigner(false);
      setDeriveKeyError(
        'This session is wallet-only. Sign in with MySocial (Google, Apple, etc.) so the app can derive your signing key from the salt service.',
      );
      setDerivingKeypair(false);
      return;
    }

    const expectedAddress = session.user?.address;
    if (!expectedAddress) {
      if (devUnblockEnabled()) {
        applyDevSigner(
          setKeypair,
          setIsUsingDevMessengerSigner,
          setDeriveKeyError,
          setDerivingKeypair,
        );
        return;
      }
      setKeypair(null);
      setIsUsingDevMessengerSigner(false);
      setDeriveKeyError('Session has no wallet address.');
      setDerivingKeypair(false);
      return;
    }

    if (!canAttemptOAuthKeypairDerivation(session)) {
      if (devUnblockEnabled()) {
        applyDevSigner(
          setKeypair,
          setIsUsingDevMessengerSigner,
          setDeriveKeyError,
          setDerivingKeypair,
        );
        return;
      }
      setKeypair(null);
      setIsUsingDevMessengerSigner(false);
      setDeriveKeyError(
        'This session is missing OAuth credentials needed to derive your signing key.',
      );
      setDerivingKeypair(false);
      return;
    }

    let cancelled = false;
    setDerivingKeypair(true);
    setDeriveKeyError(null);

    (async () => {
      try {
        const sub = resolveOAuthSubForKeypair(session);
        if (!sub) {
          throw new Error('Session is missing OAuth sub for keypair derivation.');
        }

        const salt = await getSaltFromSession(auth, session, saltUrl);
        const kp = await deriveKeypairFromSubAndSalt({
          sub,
          salt,
          expectedAddress,
        });

        if (!cancelled) {
          setKeypair(kp);
          setIsUsingDevMessengerSigner(false);
          setDeriveKeyError(null);

          try {
            const raw = getAuthSessionRaw();
            if (raw) {
              const parsed = JSON.parse(raw) as Session & { salt?: string };
              if (parsed.salt !== salt) {
                parsed.salt = salt;
                setAuthSessionRaw(JSON.stringify(parsed));
                // Re-sync singleton after out-of-band storage write.
                void auth.getSession();
              }
            }
          } catch {
            // ignore
          }
        }
      } catch (e) {
        if (!cancelled) {
          if (isSessionRevokedOrExpiredError(e)) {
            setSignInError(SESSION_EXPIRED_MESSAGE);
            setKeypair(null);
            setIsUsingDevMessengerSigner(false);
            setDeriveKeyError(null);
            setDerivingKeypair(false);
            return;
          }
          if (devUnblockEnabled()) {
            applyDevSigner(
              setKeypair,
              setIsUsingDevMessengerSigner,
              setDeriveKeyError,
              setDerivingKeypair,
            );
            console.warn(
              '[MySocialAuth] OAuth keypair derivation failed; using dev signer:',
              e,
            );
          } else {
            setKeypair(null);
            setIsUsingDevMessengerSigner(false);
            setDeriveKeyError(
              e instanceof Error ? e.message : 'Failed to derive signing key.',
            );
            setDerivingKeypair(false);
          }
        }
      } finally {
        if (!cancelled) {
          setDerivingKeypair(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [auth, session, saltUrl, deriveNonce]);

  const login = useCallback(() => {
    setSignInError(null);
    const a = authRef.current;
    if (!a) {
      setSignInError('MySocial auth is not configured.');
      return;
    }

    const mode = shouldUseRedirectAuth() ? 'redirect' : 'popup';
    void a
      .signIn({ mode, provider: 'google' })
      .then(async (s) => {
        if (mode !== 'popup' || !s) return;
        if (await rejectNonRefreshableSession(s)) {
          setSignInError(SESSION_CANNOT_REFRESH_MESSAGE);
          hadSessionRef.current = false;
          setSession(null);
          setKeypair(null);
          return;
        }
        applyRefreshTokenGuard(s, setSignInError);
      })
      .catch((e: unknown) => {
        if (mode === 'popup') {
          void a.getSession().then(async (s) => {
            if (s?.user?.address) {
              if (await rejectNonRefreshableSession(s)) {
                setSignInError(SESSION_CANNOT_REFRESH_MESSAGE);
                hadSessionRef.current = false;
                setSession(null);
                setKeypair(null);
                return;
              }
              applyRefreshTokenGuard(s, setSignInError);
              setSession(s);
              hadSessionRef.current = true;
              setDeriveNonce((n) => n + 1);
              return;
            }
            setSignInError(
              e instanceof Error ? e.message : 'Sign-in failed or was cancelled.',
            );
          });
          return;
        }
        setSignInError(
          e instanceof Error ? e.message : 'Sign-in failed or was cancelled.',
        );
      });
  }, []);

  const logout = useCallback(async () => {
    // Clear before signOut so onAuthStateChange(null) does not show "session expired"
    hadSessionRef.current = false;
    setSignInError(null);
    clearProactiveRefreshTimer();
    // Close relayer WS (group + user feed) so peers see offline even if we
    // stay on the sign-in page after logout.
    await teardownMessagingPresence();
    const a = authRef.current;
    try {
      if (a) {
        await a.signOut();
      }
    } finally {
      // Ensure shared localStorage is cleared so other tabs observe logout.
      removeAuthSession();
      setSession(null);
      setKeypair(null);
      setIsUsingDevMessengerSigner(false);
      setDeriveKeyError(null);
    }
  }, [clearProactiveRefreshTimer]);

  const configError = auth ? null : configErrorFromEnv;

  const value = useMemo(
    (): MySocialAuthContextValue => ({
      auth,
      session,
      keypair,
      isUsingDevMessengerSigner,
      walletOnlyBlocked,
      deriveKeyError,
      derivingKeypair,
      configError,
      signInError,
      login,
      logout,
      connectedAddress,
      retryKeypairDerivation,
    }),
    [
      auth,
      session,
      keypair,
      isUsingDevMessengerSigner,
      walletOnlyBlocked,
      deriveKeyError,
      derivingKeypair,
      configError,
      signInError,
      login,
      logout,
      connectedAddress,
      retryKeypairDerivation,
    ],
  );

  return (
    <MySocialAuthContext.Provider value={value}>
      {children}
    </MySocialAuthContext.Provider>
  );
}

export function useMySocialAuth(): MySocialAuthContextValue {
  const ctx = useContext(MySocialAuthContext);
  if (!ctx) {
    throw new Error('useMySocialAuth must be used within MySocialAuthProvider');
  }
  return ctx;
}

/** On-chain identity: session address until derived keypair is ready. */
export function useAuthenticatedAddress(): string | undefined {
  const { keypair, connectedAddress, derivingKeypair } = useMySocialAuth();
  if (keypair && !derivingKeypair) {
    return keypair.toMySoAddress();
  }
  return connectedAddress;
}
