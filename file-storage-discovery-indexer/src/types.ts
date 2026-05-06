export interface DiscoveryEvent {
  blobId: string;
  checkpoint: bigint;
  discoveredAt: string;
  patches: DiscoveredPatch[];
}

export interface DiscoveredPatch {
  identifier: string;
  messageId: string;
  groupId: string;
  senderAddress: string;
  syncStatus: string;
  blobId: string;
  order: number | null;
  checkpoint: string;
}
