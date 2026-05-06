import { MySoGrpcClient } from '@socialproof/myso/grpc';
import { FileStorageClient } from '@socialproof/file-storage';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { InMemoryDiscoveryStore } from './discovery-store.js';
import { createApp } from './api.js';
import { startCheckpointListener } from './checkpoint-listener.js';

// Entry point — wires config, clients, store, REST API, and checkpoint listener.
async function main() {
  const partialConfig = loadConfig();
  console.log(`File Storage Discovery Indexer starting on ${partialConfig.network}...`);

  const grpcClient = new MySoGrpcClient({
    network: partialConfig.network,
    baseUrl: partialConfig.grpcUrl,
  });

  const fileStorageClient = new FileStorageClient({
    network: partialConfig.network,
    mysoClient: grpcClient,
  });

  const blobType = await fileStorageClient.getBlobType();
  const fileStoragePackageId = blobType.split('::')[0];
  console.log(`File Storage package ID (auto-derived): ${fileStoragePackageId}`);

  const config: Config = {
    ...partialConfig,
    fileStoragePackageId,
  };

  const store = new InMemoryDiscoveryStore();

  const app = createApp(store);
  const server = app.listen(config.port, () => {
    console.log(`REST API listening on http://localhost:${config.port}`);
    console.log(`  GET /v1/groups/:groupId/patches — patches for a group`);
    console.log(`  GET /v1/patches                 — all patches`);
    console.log(`  GET /health                     — health check`);
  });

  const abortController = new AbortController();

  const shutdown = () => {
    console.log('\nShutting down...');
    abortController.abort();
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await startCheckpointListener(config, grpcClient, fileStorageClient, store, abortController.signal);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
