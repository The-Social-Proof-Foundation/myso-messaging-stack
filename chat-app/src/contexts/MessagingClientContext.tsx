import {
  createContext,
  useContext,
  useEffect,
  useMemo,
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
  const [clientLoading, setClientLoading] = useState(false);

  useEffect(() => {
    if (!keypair) {
      setClient(null);
      setClientInitError(null);
      setClientLoading(false);
      return;
    }

    let cancelled = false;
    setClientLoading(true);
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
        setClientLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          const message =
            e instanceof Error ? e.message : 'Failed to create messaging client.';
          console.error('createMySoMessagingStackClientAsync failed:', e);
          setClient(null);
          setClientInitError(message);
          setClientLoading(false);
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
