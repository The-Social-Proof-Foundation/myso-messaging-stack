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
  createMySocialAuth,
  SessionRevokedError,
  type MySocialAuth,
  type Session,
} from '@socialproof/mysocial-auth';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { deriveKeypairFromSubAndSalt } from '../lib/derive-mysocial-keypair';
import { getOrCreateDevMessengerKeypair } from '../lib/dev-signer';
import { getSaltFromSession } from '../lib/get-salt-from-session';
import { readMySocialAuthConfig } from '../lib/mysocial-auth-config';
import {
  canAttemptOAuthKeypairDerivation,
  isTrueWalletOnlySession,
  resolveOAuthSubForKeypair,
  shouldUseRedirectAuth,
  SESSION_STORAGE_KEY,
} from '../lib/auth-utils';

const SESSION_EXPIRED_MESSAGE =
  'Session expired — please sign in again';

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
  const { config: authConfig, error: configErrorFromEnv } = useMemo(
    () => readMySocialAuthConfig(),
    [],
  );

  const auth = useMemo(() => {
    if (!authConfig) return null;
    return createMySocialAuth(authConfig);
  }, [authConfig]);

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

  const retryKeypairDerivation = useCallback(() => {
    setDeriveNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!auth) {
      setSession(null);
      return;
    }

    let cancelled = false;

    void auth.getSession().then((s) => {
      if (!cancelled) {
        setSession(s);
        hadSessionRef.current = Boolean(s);
      }
    });

    const unsub = auth.onAuthStateChange((s) => {
      if (!s && hadSessionRef.current) {
        setSignInError(SESSION_EXPIRED_MESSAGE);
        setKeypair(null);
        setIsUsingDevMessengerSigner(false);
        setDeriveKeyError(null);
      }
      hadSessionRef.current = Boolean(s);
      setSession(s);
      setDeriveNonce((n) => n + 1);
    });

    const onBroadcast = () => {
      void auth.getSession().then((s) => {
        if (s) {
          setSignInError(null);
        }
        hadSessionRef.current = Boolean(s);
        setSession(s);
        setDeriveNonce((n) => n + 1);
      });
    };
    window.addEventListener('mysocial-auth-broadcast-session', onBroadcast);
    window.addEventListener('mysocial-auth-session-changed', onBroadcast);

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      void auth.getSession().then((s) => {
        if (cancelled) return;
        if (s) {
          setSignInError(null);
        }
        hadSessionRef.current = Boolean(s);
        setSession(s);
        setDeriveNonce((n) => n + 1);
      });
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      unsub();
      window.removeEventListener('mysocial-auth-broadcast-session', onBroadcast);
      window.removeEventListener('mysocial-auth-session-changed', onBroadcast);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [auth]);

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
            const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
            if (raw) {
              const parsed = JSON.parse(raw) as Session & { salt?: string };
              if (parsed.salt !== salt) {
                parsed.salt = salt;
                sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(parsed));
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
      .catch((e: unknown) => {
        if (mode === 'popup') {
          void a.getSession().then((s) => {
            if (s?.user?.address) {
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
    const a = authRef.current;
    if (a) {
      await a.signOut();
    }
    setKeypair(null);
    setIsUsingDevMessengerSigner(false);
    setDeriveKeyError(null);
  }, []);

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
