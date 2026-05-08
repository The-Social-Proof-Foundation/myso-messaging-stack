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
  isWalletOnlySession,
  type MySocialAuth,
  type Session,
} from '@socialproof/mysocial-auth';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { deriveKeypairFromSaltService } from '../lib/derive-mysocial-keypair';
import { getOrCreateDevMessengerKeypair } from '../lib/dev-signer';

function devUnblockEnabled(): boolean {
	const v = import.meta.env.VITE_DEV_UNBLOCK_MESSAGING_UI;
	return v === 'true' || v === '1' || v === 'yes';
}

interface MySocialAuthContextValue {
  auth: MySocialAuth | null;
  /** Current session after login refresh, if any */
  session: Session | null;
  /** Signing key derived from OAuth session + salt; null until derivation succeeds */
  keypair: Ed25519Keypair | null;
  /** True when using local dev ephemeral signer (see VITE_DEV_UNBLOCK_MESSAGING_UI) */
  isUsingDevMessengerSigner: boolean;
  /** True when user is authenticated but wallet-only (cannot call /salt) */
  walletOnlyBlocked: boolean;
  /** Recoverable error while fetching salt / deriving keypair */
  deriveKeyError: string | null;
  derivingKeypair: boolean;
  /** Misconfigured auth env vars */
  configError: string | null;
  /** Popup sign-in failure (blocked, timeout, etc.) */
  signInError: string | null;
  /** Must be invoked synchronously inside a click handler (Safari popup rules). Errors land in signInError. */
  login: () => void;
  logout: () => Promise<void>;
  /** Wallet address when session exists */
  connectedAddress: string | undefined;
}

const MySocialAuthContext = createContext<MySocialAuthContextValue | null>(
  null,
);

function readAuthConfig(): {
  config: Parameters<typeof createMySocialAuth>[0] | null;
  error: string | null;
} {
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
      ? ' Preview/production bundles read env only at build time. Run vite build again after changing .env, or use pnpm dev during local development.'
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
      storage: 'session' as const,
    },
    error: null,
  };
}

export function MySocialAuthProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { config: authConfig, error: configErrorFromEnv } = useMemo(
    () => readAuthConfig(),
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

  const authRef = useRef(auth);
  authRef.current = auth;

  // Bootstrap + subscribe
  useEffect(() => {
    if (!auth) {
      setSession(null);
      return;
    }

    let cancelled = false;

    void auth.getSession().then((s) => {
      if (!cancelled) setSession(s);
    });

    const unsub = auth.onAuthStateChange((s) => {
      setSession(s);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [auth]);

  const walletOnlyBlocked = Boolean(session && isWalletOnlySession(session));

  const connectedAddress = session?.user?.address;

  // Derive keypair when we have a full OAuth session (not wallet-only)
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

    if (isWalletOnlySession(session)) {
      if (devUnblockEnabled()) {
        setKeypair(getOrCreateDevMessengerKeypair());
        setIsUsingDevMessengerSigner(true);
        setDeriveKeyError(null);
        setDerivingKeypair(false);
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
        setKeypair(getOrCreateDevMessengerKeypair());
        setIsUsingDevMessengerSigner(true);
        setDeriveKeyError(null);
        setDerivingKeypair(false);
        return;
      }
      setKeypair(null);
      setIsUsingDevMessengerSigner(false);
      setDeriveKeyError('Session has no wallet address.');
      setDerivingKeypair(false);
      return;
    }

    let cancelled = false;
    setDerivingKeypair(true);
    setDeriveKeyError(null);

    (async () => {
      try {
        const token = await auth.getAccessTokenForApi();
        if (!token) {
          throw new Error('No API access token; cannot call salt service.');
        }
        const kp = await deriveKeypairFromSaltService({
          saltUrl,
          accessToken: token,
          sub: session.sub,
          expectedAddress,
        });
        if (!cancelled) {
          setKeypair(kp);
          setIsUsingDevMessengerSigner(false);
          setDeriveKeyError(null);
        }
      } catch (e) {
        if (!cancelled) {
          if (devUnblockEnabled()) {
            setKeypair(getOrCreateDevMessengerKeypair());
            setIsUsingDevMessengerSigner(true);
            setDeriveKeyError(null);
          } else {
            setKeypair(null);
            setIsUsingDevMessengerSigner(false);
            setDeriveKeyError(
              e instanceof Error ? e.message : 'Failed to derive signing key.',
            );
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
  }, [auth, session, saltUrl]);

  const login = useCallback(() => {
    setSignInError(null);
    const a = authRef.current;
    if (!a) {
      setSignInError('MySocial auth is not configured.');
      return;
    }
    void a
      .signIn({ mode: 'popup', provider: 'none' })
      .catch((e: unknown) => {
        setSignInError(
          e instanceof Error ? e.message : 'Sign-in failed or was cancelled.',
        );
      });
  }, []);

  const logout = useCallback(async () => {
    const a = authRef.current;
    if (a) {
      await a.signOut();
    }
    setKeypair(null);
    setIsUsingDevMessengerSigner(false);
    setDeriveKeyError(null);
    setSignInError(null);
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

/** On-chain identity for messaging: always the derived keypair address when signed in (matches signer + permission checks). */
export function useAuthenticatedAddress(): string | undefined {
  const { keypair, connectedAddress } = useMySocialAuth();
  if (keypair) {
    return keypair.toMySoAddress();
  }
  return connectedAddress;
}
