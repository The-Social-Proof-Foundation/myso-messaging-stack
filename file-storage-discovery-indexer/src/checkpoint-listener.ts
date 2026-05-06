import type { MySoGrpcClient } from '@socialproof/myso/grpc';
import type { FileStorageClient } from '@socialproof/file-storage';
import { parseFileStorageEvent } from './event-parser.js';
import { inspectBlob } from './blob-inspector.js';
import type { DiscoveryStore } from './discovery-store.js';
import type { Config } from './config.js';

const MAX_CONCURRENT_INSPECTIONS = 10;

// Start the gRPC checkpoint listener loop with auto-reconnect on stream errors.
export async function startCheckpointListener(
  config: Config,
  grpcClient: MySoGrpcClient,
  fileStorageClient: FileStorageClient,
  store: DiscoveryStore,
  signal: AbortSignal,
): Promise<void> {
  console.log(`Connecting to MySo gRPC at ${config.grpcUrl}...`);
  console.log(`Filtering for File Storage package: ${config.fileStoragePackageId}`);
  if (config.publisherMySoAddress) {
    console.log(`Sender filter active: ${config.publisherMySoAddress}`);
  }

  let inFlight = 0;

  while (!signal.aborted) {
    try {
      const call = grpcClient.subscriptionService.subscribeCheckpoints({
        readMask: { paths: ['sequence_number', 'transactions.events'] },
      });

      console.log('Checkpoint stream connected, processing events...');

      for await (const response of call.responses) {
        if (signal.aborted) break;

        const checkpoint = response.checkpoint;
        if (!checkpoint) continue;

        const checkpointSeq = response.cursor ?? checkpoint.sequenceNumber ?? 0n;

        for (const tx of checkpoint.transactions) {
          const events = tx.events?.events ?? [];

          for (const event of events) {
            if (config.publisherMySoAddress && event.sender) {
              if (event.sender.toLowerCase() !== config.publisherMySoAddress.toLowerCase()) {
                continue;
              }
            }

            const parsed = parseFileStorageEvent(event, config.fileStoragePackageId);
            if (!parsed) continue;

            if (inFlight >= MAX_CONCURRENT_INSPECTIONS) continue;

            inFlight++;
            inspectBlob(fileStorageClient, parsed.blobId, checkpointSeq)
              .then((discovery) => {
                if (discovery) {
                  store.addDiscovery(discovery);
                  console.log(
                    `[checkpoint ${checkpointSeq}] Discovered quilt ${parsed.blobId} ` +
                    `with ${discovery.patches.length} message(s)`
                  );
                }
              })
              .catch(() => {})
              .finally(() => { inFlight--; });
          }
        }

        store.setLastCheckpoint(checkpointSeq);
      }
    } catch (error) {
      if (signal.aborted) break;
      console.error('gRPC stream error, reconnecting in 5s...', error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  console.log('Checkpoint listener stopped.');
}
