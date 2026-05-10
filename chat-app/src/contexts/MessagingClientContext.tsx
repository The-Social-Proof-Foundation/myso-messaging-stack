import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';
import {
  createMySoMessagingStackClient,
  FileStorageHttpStorageAdapter,
} from '@socialproof/myso-messaging-stack';
import { MySoGraphQLClient } from '@socialproof/myso/graphql';
import {
  MySoJsonRpcClient,
  getJsonRpcFullnodeUrl,
} from '@socialproof/myso/jsonRpc';
import type { Signer } from '@socialproof/myso/cryptography';

import { useMySocialAuth } from './MySocialAuthContext';

// Infer the client type from the factory return
type MessagingClient = ReturnType<typeof createMySoMessagingStackClient>;

interface MessagingClientContextValue {
  client: MessagingClient | null;
  signer: Signer | null;
  /** Set when client construction threw (otherwise debugging is a white screen). */
  clientInitError: string | null;
  graphqlClient: MySoGraphQLClient;
}

const MessagingClientContext =
  createContext<MessagingClientContextValue | null>(null);

// --- Environment config ---
const NETWORK_RAW = import.meta.env.VITE_MYSO_NETWORK || 'testnet';
const KNOWN_RPC_NETWORK =
  NETWORK_RAW === 'mainnet' ||
  NETWORK_RAW === 'testnet' ||
  NETWORK_RAW === 'devnet' ||
  NETWORK_RAW === 'localnet'
    ? NETWORK_RAW
    : 'testnet';
const NETWORK = NETWORK_RAW;
const RELAYER_URL =
  import.meta.env.VITE_RELAYER_URL || 'http://localhost:3003';
const GRAPHQL_URL =
  import.meta.env.VITE_MYSO_GRAPHQL_URL || '/api/graphql';

const FILE_STORAGE_PUBLISHER_URL =
  import.meta.env.VITE_FILE_STORAGE_PUBLISHER_URL || '';
const FILE_STORAGE_AGGREGATOR_URL =
  import.meta.env.VITE_FILE_STORAGE_AGGREGATOR_URL || '';
const FILE_STORAGE_EPOCHS = Number(import.meta.env.VITE_FILE_STORAGE_EPOCHS) || 1;

function parsePackageConfig() {
  const originalPackageId = import.meta.env.VITE_MESSAGING_ORIGINAL_PACKAGE_ID;
  if (!originalPackageId) return undefined;
  return {
    messaging: {
      originalPackageId,
      latestPackageId:
        import.meta.env.VITE_MESSAGING_LATEST_PACKAGE_ID ||
        originalPackageId,
      namespaceId: import.meta.env.VITE_MESSAGING_NAMESPACE_ID || '',
      versionId: import.meta.env.VITE_MESSAGING_VERSION_ID || '',
    },
  };
}

function parseMyDataServerConfigs(): { objectId: string; weight: number }[] {
  const ids = import.meta.env.VITE_MYDATA_KEY_SERVER_OBJECT_IDS;
  if (!ids) return [];
  return ids.split(',').map((id: string) => ({
    objectId: id.trim(),
    weight: 1,
  }));
}

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

  const rpcUrl =
    import.meta.env.VITE_MYSO_RPC_URL ||
    getJsonRpcFullnodeUrl(KNOWN_RPC_NETWORK);

  const { client, signer, clientInitError } = useMemo(() => {
    const baseClient = new MySoJsonRpcClient({
      url: rpcUrl,
      network: NETWORK,
    });

    if (!keypair) {
      return {
        client: null,
        signer: null,
        clientInitError: null,
      };
    }

    const mydataServerConfigs = parseMyDataServerConfigs();

    const attachments =
      FILE_STORAGE_PUBLISHER_URL && FILE_STORAGE_AGGREGATOR_URL
        ? {
            storageAdapter: new FileStorageHttpStorageAdapter({
              publisherUrl: FILE_STORAGE_PUBLISHER_URL,
              aggregatorUrl: FILE_STORAGE_AGGREGATOR_URL,
              epochs: FILE_STORAGE_EPOCHS,
              fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
            }),
            maxFileSizeBytes: 5 * 1024 * 1024,
            maxAttachments: 10,
          }
        : undefined;

    try {
      const client = createMySoMessagingStackClient(baseClient, {
        mydata: {
          serverConfigs: mydataServerConfigs,
        },
        encryption: {
          sessionKey: {
            signer: keypair,
          },
        },
        packageConfig: parsePackageConfig(),
        relayer: {
          relayerUrl: RELAYER_URL,
          fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
        },
        attachments,
      });

      return {
        client,
        signer: keypair,
        clientInitError: null,
      };
    } catch (e) {
      const message =
        e instanceof Error ? e.message : 'Failed to create messaging client.';
      console.error('createMySoMessagingStackClient failed:', e);
      return {
        client: null,
        signer: keypair,
        clientInitError: message,
      };
    }
  }, [keypair, rpcUrl]);

  const value = useMemo(
    () => ({ client, signer, clientInitError, graphqlClient }),
    [client, signer, clientInitError],
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
    throw new Error(
      'Sign in with MySocial and wait for signing key derivation to use messaging.',
    );
  }
  return { client: ctx.client, signer: ctx.signer };
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

/** Non-fatal client bootstrap failure (see try/catch around createMySoMessagingStackClient). */
export function useMessagingClientInitError(): string | null {
  const ctx = useContext(MessagingClientContext);
  if (!ctx) {
    throw new Error(
      'useMessagingClientInitError must be used within <MessagingClientProvider>',
    );
  }
  return ctx.clientInitError;
}
