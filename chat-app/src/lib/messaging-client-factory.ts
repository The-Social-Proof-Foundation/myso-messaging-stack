import {
  clearGenesisMessagingConfigCache,
  createMySoMessagingStackClientAsync,
  FileStorageHttpStorageAdapter,
  RelayerArchiveRecoveryTransport,
} from '@socialproof/myso-messaging-stack';
import type { Signer } from '@socialproof/myso/cryptography';
import {
  JsonRpcHTTPTransport,
  MySoJsonRpcClient,
  getJsonRpcFullnodeUrl,
} from '@socialproof/myso/jsonRpc';

const NETWORK_RAW = import.meta.env.VITE_MYSO_NETWORK || 'testnet';
const KNOWN_RPC_NETWORK =
  NETWORK_RAW === 'mainnet' ||
  NETWORK_RAW === 'testnet' ||
  NETWORK_RAW === 'devnet' ||
  NETWORK_RAW === 'localnet'
    ? NETWORK_RAW
    : 'testnet';

const RELAYER_URL =
  import.meta.env.VITE_RELAYER_URL || 'http://localhost:3003';

const SOCIAL_SERVER_URL = import.meta.env.VITE_SOCIAL_SERVER_URL || '';

const FILE_STORAGE_PUBLISHER_URL =
  import.meta.env.VITE_FILE_STORAGE_PUBLISHER_URL || '';
const FILE_STORAGE_AGGREGATOR_URL =
  import.meta.env.VITE_FILE_STORAGE_AGGREGATOR_URL || '';
const FILE_STORAGE_EPOCHS = Number(import.meta.env.VITE_FILE_STORAGE_EPOCHS) || 1;

const ARCHIVE_NAMESPACE =
  import.meta.env.VITE_ARCHIVE_NAMESPACE || 'mysocial';
const ENABLE_MESSAGE_RECOVERY =
  import.meta.env.VITE_ENABLE_MESSAGE_RECOVERY === 'true' ||
  import.meta.env.VITE_ENABLE_MESSAGE_RECOVERY === '1';

/** True when relayer R2 archive recovery is enabled for this build. */
export function isMessageRecoveryEnabled(): boolean {
  return ENABLE_MESSAGE_RECOVERY;
}

export type MessagingClient = Awaited<
  ReturnType<typeof createMySoMessagingStackClientAsync>
>;

export function getMessagingNetwork(): string {
  return NETWORK_RAW;
}

export function getMessagingRpcUrl(): string {
  const envUrl = import.meta.env.VITE_MYSO_RPC_URL;

  if (import.meta.env.DEV && NETWORK_RAW === 'localnet' && envUrl?.startsWith('http')) {
    // Same-origin Vite proxy avoids CORS; target is VITE_MYSO_RPC_URL (see vite.config.ts).
    return '/api/rpc';
  }

  if (envUrl) {
    return envUrl;
  }

  return getJsonRpcFullnodeUrl(KNOWN_RPC_NETWORK);
}

export function getGenesisGraphqlUrl(): string | undefined {
  const url = import.meta.env.VITE_MYSO_GRAPHQL_URL || '/api/graphql';
  return url.startsWith('http') ? url : undefined;
}

function parseMyDataServerConfigs(): { objectId: string; weight: number }[] {
  const ids = import.meta.env.VITE_MYDATA_KEY_SERVER_OBJECT_IDS;
  if (!ids) return [];
  return ids.split(',').map((id: string) => ({
    objectId: id.trim(),
    weight: 1,
  }));
}

function parseMyDataThreshold(): number | undefined {
  const raw = import.meta.env.VITE_MYDATA_THRESHOLD;
  if (raw === undefined || raw === '') return undefined;
  const threshold = Number(raw);
  if (!Number.isInteger(threshold) || threshold < 1) {
    console.warn(
      `Invalid VITE_MYDATA_THRESHOLD "${raw}"; using SDK default (2).`,
    );
    return undefined;
  }
  return threshold;
}

function buildAttachmentsConfig():
  | {
      storageAdapter: FileStorageHttpStorageAdapter;
      maxFileSizeBytes: number;
      maxAttachments: number;
    }
  | undefined {
  if (!FILE_STORAGE_PUBLISHER_URL || !FILE_STORAGE_AGGREGATOR_URL) {
    return undefined;
  }
  return {
    storageAdapter: new FileStorageHttpStorageAdapter({
      publisherUrl: FILE_STORAGE_PUBLISHER_URL,
      aggregatorUrl: FILE_STORAGE_AGGREGATOR_URL,
      epochs: FILE_STORAGE_EPOCHS,
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    }),
    maxFileSizeBytes: 5 * 1024 * 1024,
    maxAttachments: 10,
  };
}

const attachmentsConfig = buildAttachmentsConfig();

/** Bound fetch for browser SDK clients (avoids "Illegal invocation" when stored as a method). */
const browserFetch: typeof fetch = (...args) => fetch(...args);

export function createBaseMySoRpcClient(): MySoJsonRpcClient {
  const url = getMessagingRpcUrl();
  return new MySoJsonRpcClient({
    network: NETWORK_RAW,
    transport: new JsonRpcHTTPTransport({
      url,
      fetch: browserFetch,
    }),
  });
}

/**
 * Build a messaging client with a fresh genesis resolve (optional cache bypass).
 * Use before create-group so packageConfig matches live GraphQL singletons.
 */
export async function createFreshMessagingClient(
  signer: Signer,
  options?: { bypassGenesisCache?: boolean },
): Promise<MessagingClient> {
  if (options?.bypassGenesisCache) {
    clearGenesisMessagingConfigCache();
  }

  const baseClient = createBaseMySoRpcClient();
  const mydataThreshold = parseMyDataThreshold();

  const recovery = isMessageRecoveryEnabled()
    ? new RelayerArchiveRecoveryTransport({
        relayerUrl: RELAYER_URL,
        namespace: ARCHIVE_NAMESPACE,
        signer,
        apiPrefix: '/v1',
        fetch: browserFetch,
      })
    : undefined;

  return createMySoMessagingStackClientAsync(baseClient, {
    mydata: {
      serverConfigs: parseMyDataServerConfigs(),
    },
    encryption: {
      sessionKey: {
        signer,
      },
      ...(mydataThreshold !== undefined && { mydataThreshold }),
    },
    relayer: {
      relayerUrl: RELAYER_URL,
      apiPrefix: '/v1',
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    },
    ...(SOCIAL_SERVER_URL
      ? {
          blockGating: {
            socialServerUrl: SOCIAL_SERVER_URL,
            fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
          },
        }
      : {}),
    ...(recovery ? { recovery } : {}),
    attachments: attachmentsConfig,
    genesis: {
      graphqlUrl: getGenesisGraphqlUrl(),
      rpcUrl: getMessagingRpcUrl(),
    },
  });
}
