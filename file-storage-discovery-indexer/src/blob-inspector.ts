import type { FileStorageClient } from '@socialproof/file-storage';
import type { DiscoveryEvent } from './types.js';
import { MSG_PREFIX, SOURCE_TAG } from './constants.js';

// Inspect a File Storage blob for messaging patches using quilt index tags.
export async function inspectBlob(
  fileStorageClient: FileStorageClient,
  blobId: string,
  checkpoint: bigint,
): Promise<DiscoveryEvent | null> {
  try {
    const blob = await fileStorageClient.getBlob({ blobId });

    // Filter by source tag - only returns patches from this relayer
    const files = await blob.files({ tags: [{ source: SOURCE_TAG }] });
    if (files.length === 0) return null;

    const patches = [];
    for (const file of files) {
      try {
        const identifier = await file.getIdentifier();
        if (!identifier?.startsWith(MSG_PREFIX)) continue;

        // Read metadata from quilt index tags (no content fetch needed)
        const tags = await file.getTags();

        patches.push({
          identifier,
          messageId: identifier.replace(MSG_PREFIX, ''),
          groupId: tags.group_id ?? '',
          senderAddress: tags.sender ?? '',
          syncStatus: tags.sync_status ?? '',
          blobId,
          order: tags.order ? parseInt(tags.order, 10) : null,
          checkpoint: checkpoint.toString(),
        });
      } catch {
        console.warn(`Failed to read tags for patch in blob ${blobId}`);
      }
    }

    if (patches.length === 0) return null;

    return {
      blobId,
      checkpoint,
      discoveredAt: new Date().toISOString(),
      patches,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes('Unsupported quilt version')) {
      console.warn(`Failed to inspect blob ${blobId}: ${msg}`);
    }
    return null;
  }
}
