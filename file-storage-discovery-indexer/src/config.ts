import 'dotenv/config';

export type Network = 'testnet' | 'mainnet';

export interface Config {
  network: Network;
  grpcUrl: string;
  fileStoragePackageId: string;
  publisherMySoAddress?: string;
  port: number;
}

const GRPC_URLS: Record<Network, string> = {
  testnet: 'https://fullnode.testnet.mysocial.network:443',
  mainnet: 'https://fullnode.mainnet.mysocial.network:443',
};

// Load and validate environment variables into a typed config object.
export function loadConfig(): Omit<Config, 'fileStoragePackageId'> {
  const network = process.env.NETWORK as Network;
  if (!network || !['testnet', 'mainnet'].includes(network)) {
    throw new Error('NETWORK must be "testnet" or "mainnet"');
  }

  return {
    network,
    grpcUrl: GRPC_URLS[network],
    publisherMySoAddress: process.env.FILE_STORAGE_PUBLISHER_MYSO_ADDRESS || undefined,
    port: parseInt(process.env.PORT || '3001', 10),
  };
}
