import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { MySoGraphQLClient } from '@socialproof/myso/graphql';
import type { Signer } from '@socialproof/myso/cryptography';

import {
  createFreshMessagingClient,
  getGenesisGraphqlUrl,
  getMessagingNetwork,
  getMessagingRpcUrl,
  type MessagingClient,
} from '../lib/messaging-client-factory';
import {
  fetchAndLogGenesisConfig,
  logClientDeriveIds,
  logFullGenesisClientMismatch,
} from '../lib/messaging-genesis-debug';
import { clearMessageCache } from '../lib/message-session-cache';
import { registerMessagingPresenceTeardown } from '../lib/messaging-presence-teardown';
import { useMySocialAuth } from './MySocialAuthContext';

interface MessagingClientContextValue {
  client: MessagingClient | null;
  signer: Signer | null;
  clientInitError: string | null;
  clientLoading: boolean;
  graphqlClient: MySoGraphQLClient;
  /** Rebuild messaging client with fresh genesis (e.g. before create-group). */
  createFreshMessagingClient: (
    options?: { bypassGenesisCache?: boolean },
  ) => Promise<MessagingClient>;
}

const MessagingClientContext =
  createContext<MessagingClientContextValue | null>(null);

const NETWORK = getMessagingNetwork();
const GRAPHQL_URL =
  import.meta.env.VITE_MYSO_GRAPHQL_URL || '/api/graphql';

const graphqlClient = new MySoGraphQLClient({
  url: GRAPHQL_URL,
  network: NETWORK,
});

export function MessagingClientProvider({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const { keypair } = useMySocialAuth();

  const [client, setClient] = useState<MessagingClient | null>(null);
  const [clientInitError, setClientInitError] = useState<string | null>(null);
  const cachedSignerAddressRef = useRef<string | null>(null);
  const clientRef = useRef<MessagingClient | null>(null);
  const keypairRef = useRef(keypair);
  clientRef.current = client;
  keypairRef.current = keypair;

  // Synchronous: true on the same render keypair appears, before useEffect runs.
  const clientLoading = Boolean(keypair && !client && !clientInitError);

  // Logout (and identity clear) must close WS sockets while we still have a client.
  useEffect(() => {
    registerMessagingPresenceTeardown(async () => {
      const activeClient = clientRef.current;
      const activeSigner = keypairRef.current;
      if (!activeClient || !activeSigner) return;
      try {
        await activeClient.messaging.transport.postPresence({
          signer: activeSigner,
          active: false,
        });
      } catch {
        // Best-effort last-seen; live offline comes from WS close.
      }
      activeClient.messaging.disconnect();
    });
    return () => registerMessagingPresenceTeardown(null);
  }, []);

  useEffect(() => {
    const address = keypair?.toMySoAddress() ?? null;
    // Wipe plaintext when the signing identity changes (logout or account switch).
    if (address !== cachedSignerAddressRef.current) {
      const prev = clientRef.current;
      if (prev && !address) {
        // Keypair cleared without going through teardownMessagingPresence —
        // still drop sockets so peers see offline.
        try {
          prev.messaging.disconnect();
        } catch {
          // ignore
        }
      }
      clearMessageCache();
      cachedSignerAddressRef.current = address;
    }

    if (!keypair) {
      setClient(null);
      setClientInitError(null);
      return;
    }

    let cancelled = false;
    setClientInitError(null);

    void createFreshMessagingClient(keypair, { bypassGenesisCache: true })
      .then(async (resolvedClient) => {
        if (cancelled) return;

        try {
          const freshGenesis = await fetchAndLogGenesisConfig(
            resolvedClient,
            'client-init (fresh graphql)',
          );
          logClientDeriveIds(
            'client-init (client.messaging.derive)',
            resolvedClient.messaging.derive,
          );
          logFullGenesisClientMismatch(
            'client-init',
            freshGenesis,
            resolvedClient,
          );
        } catch (logError) {
          console.warn('[chat-app] genesis debug logging failed:', logError);
        }

        setClient(resolvedClient);
      })
      .catch((e) => {
        if (!cancelled) {
          const message =
            e instanceof Error ? e.message : 'Failed to create messaging client.';
          console.error('createMySoMessagingStackClientAsync failed:', e);
          setClient(null);
          setClientInitError(message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [keypair]);

  const value = useMemo(
    () => ({
      client,
      signer: keypair,
      clientInitError,
      clientLoading,
      graphqlClient,
      createFreshMessagingClient: (options?: { bypassGenesisCache?: boolean }) => {
        if (!keypair) {
          throw new Error('Sign in before creating a messaging client.');
        }
        return createFreshMessagingClient(keypair, options);
      },
    }),
    [client, keypair, clientInitError, clientLoading],
  );

  return (
    <MessagingClientContext.Provider value={value}>
      {children}
    </MessagingClientContext.Provider>
  );
}

export function useMessagingClient(): MessagingClient | null {
  const ctx = useContext(MessagingClientContext);
  if (!ctx) {
    throw new Error(
      'useMessagingClient must be used within <MessagingClientProvider>',
    );
  }
  return ctx.client;
}

export function useRequiredMessagingClient(): {
  client: MessagingClient;
  signer: Signer;
  createFreshMessagingClient: (
    options?: { bypassGenesisCache?: boolean },
  ) => Promise<MessagingClient>;
} {
  const ctx = useContext(MessagingClientContext);
  if (!ctx) {
    throw new Error(
      'useRequiredMessagingClient must be used within <MessagingClientProvider>',
    );
  }
  if (!ctx.client || !ctx.signer) {
    if (ctx.clientInitError) {
      throw new Error(ctx.clientInitError);
    }
    if (ctx.clientLoading) {
      throw new Error('Messaging client is still initializing genesis config…');
    }
    throw new Error(
      'Sign in with MySocial and wait for signing key derivation to use messaging.',
    );
  }
  return {
    client: ctx.client,
    signer: ctx.signer,
    createFreshMessagingClient: ctx.createFreshMessagingClient,
  };
}

export function useGraphQLClient(): MySoGraphQLClient {
  const ctx = useContext(MessagingClientContext);
  if (!ctx) {
    throw new Error(
      'useGraphQLClient must be used within <MessagingClientProvider>',
    );
  }
  return ctx.graphqlClient;
}

export function useMessagingClientInitError(): string | null {
  const ctx = useContext(MessagingClientContext);
  if (!ctx) {
    throw new Error(
      'useMessagingClientInitError must be used within <MessagingClientProvider>',
    );
  }
  return ctx.clientInitError;
}

export function useMessagingClientLoading(): boolean {
  const ctx = useContext(MessagingClientContext);
  if (!ctx) {
    throw new Error(
      'useMessagingClientLoading must be used within <MessagingClientProvider>',
    );
  }
  return ctx.clientLoading;
}

// Re-export for callers that need RPC URL in diagnostics.
export { getMessagingRpcUrl, getGenesisGraphqlUrl };
