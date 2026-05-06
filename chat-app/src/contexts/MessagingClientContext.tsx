import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  useCurrentAccount,
  useSignPersonalMessage,
  useMySoClient,
} from '@socialproof/dapp-kit';
import { createMySoMessagingStackClient, FileStorageHttpStorageAdapter } from '@socialproof/myso-messaging-stack';
import { MySoGraphQLClient } from '@socialproof/myso/graphql';
import { DappKitSigner } from '../lib/dapp-kit-signer';

import type { Signer } from '@socialproof/myso/cryptography';

// Infer the client type from the factory return
type MessagingClient = ReturnType<typeof createMySoMessagingStackClient>;

interface MessagingClientContextValue {
  client: MessagingClient | null;
  signer: Signer | null;
  graphqlClient: MySoGraphQLClient;
}

const MessagingClientContext = createContext<MessagingClientContextValue | null>(
  null,
);

// --- Environment config ---
const RELAYER_URL =
  import.meta.env.VITE_RELAYER_URL || 'http://localhost:3000';
const GRAPHQL_URL =
  import.meta.env.VITE_MYSO_GRAPHQL_URL ||
  '/api/graphql';

// File Storage storage (for file attachments)
const FILE_STORAGE_PUBLISHER_URL =
  import.meta.env.VITE_FILE_STORAGE_PUBLISHER_URL || '';
const FILE_STORAGE_AGGREGATOR_URL =
  import.meta.env.VITE_FILE_STORAGE_AGGREGATOR_URL || '';
const FILE_STORAGE_EPOCHS = Number(import.meta.env.VITE_FILE_STORAGE_EPOCHS) || 1;

// Package config overrides (optional — auto-detected from network if not set)
function parsePackageConfig() {
  const originalPackageId = import.meta.env.VITE_MESSAGING_ORIGINAL_PACKAGE_ID;
  if (!originalPackageId) return undefined;
  return {
    messaging: {
      originalPackageId,
      latestPackageId: import.meta.env.VITE_MESSAGING_LATEST_PACKAGE_ID || originalPackageId,
      namespaceId: import.meta.env.VITE_MESSAGING_NAMESPACE_ID || '',
      versionId: import.meta.env.VITE_MESSAGING_VERSION_ID || '',
    },
  };
}

// MyData key server object IDs (comma-separated in env)
function parseMyDataServerConfigs(): { objectId: string; weight: number }[] {
  const ids = import.meta.env.VITE_MYDATA_KEY_SERVER_OBJECT_IDS;
  if (!ids) return [];
  return ids.split(',').map((id: string) => ({
    objectId: id.trim(),
    weight: 1,
  }));
}

// Singleton GraphQL client (does not depend on wallet)
const graphqlClient = new MySoGraphQLClient({ url: GRAPHQL_URL, network: 'testnet' });

export function MessagingClientProvider({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const account = useCurrentAccount();
  const mysoClient = useMySoClient();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();

  // Stabilize signPersonalMessage so it doesn't cause client recreation on every render
  const signRef = useRef(signPersonalMessage);
  useEffect(() => {
    signRef.current = signPersonalMessage;
  }, [signPersonalMessage]);

  const { client, signer } = useMemo(() => {
    if (!account) return { client: null, signer: null };

    const signer = new DappKitSigner({
      address: account.address,
      publicKeyBytes: account.publicKey
        ? new Uint8Array(account.publicKey)
        : undefined,
      signPersonalMessage: (args) =>
        signRef.current({ message: args.message }),
    });

    const mydataServerConfigs = parseMyDataServerConfigs();

    // Build optional attachments config when File Storage URLs are provided
    const attachments =
      FILE_STORAGE_PUBLISHER_URL && FILE_STORAGE_AGGREGATOR_URL
        ? {
            storageAdapter: new FileStorageHttpStorageAdapter({
              publisherUrl: FILE_STORAGE_PUBLISHER_URL,
              aggregatorUrl: FILE_STORAGE_AGGREGATOR_URL,
              epochs: FILE_STORAGE_EPOCHS,
              fetch: (...args) => fetch(...args),
            }),
            maxFileSizeBytes: 5 * 1024 * 1024, // 5 MB per file
            maxAttachments: 10,
          }
        : undefined;

    const client = createMySoMessagingStackClient(mysoClient, {
      mydata: {
        serverConfigs: mydataServerConfigs,
      },
      encryption: {
        sessionKey: {
          address: account.address,
          onSign: async (message: Uint8Array) => {
            const { signature } = await signRef.current({ message });
            return signature;
          },
        },
      },
      packageConfig: parsePackageConfig(),
      relayer: {
        relayerUrl: RELAYER_URL,
        fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      },
      attachments,
    });

    return { client, signer };
  }, [account, mysoClient]);

  const value = useMemo(
    () => ({ client, signer, graphqlClient }),
    [client, signer],
  );

  return (
    <MessagingClientContext.Provider value={value}>
      {children}
    </MessagingClientContext.Provider>
  );
}

/**
 * Access the SDK client. Returns null when wallet is disconnected.
 * Use `useRequiredMessagingClient()` when you know the wallet must be connected.
 */
export function useMessagingClient(): MessagingClient | null {
  const ctx = useContext(MessagingClientContext);
  if (!ctx) {
    throw new Error(
      'useMessagingClient must be used within <MessagingClientProvider>',
    );
  }
  return ctx.client;
}

/** Access the SDK client, throwing if wallet is disconnected. */
export function useRequiredMessagingClient(): { client: MessagingClient; signer: Signer } {
  const ctx = useContext(MessagingClientContext);
  if (!ctx) {
    throw new Error(
      'useRequiredMessagingClient must be used within <MessagingClientProvider>',
    );
  }
  if (!ctx.client || !ctx.signer) {
    throw new Error('Wallet must be connected to use messaging client');
  }
  return { client: ctx.client, signer: ctx.signer };
}

/** Access the MySo GraphQL client for group discovery queries. */
export function useGraphQLClient(): MySoGraphQLClient {
  const ctx = useContext(MessagingClientContext);
  if (!ctx) {
    throw new Error(
      'useGraphQLClient must be used within <MessagingClientProvider>',
    );
  }
  return ctx.graphqlClient;
}
