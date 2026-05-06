import type { DiscoveredPatch, DiscoveryEvent } from './types.js';

// Interface for the discovery store - swap implementations for production (DB-backed, etc.).
export interface DiscoveryStore {
  addDiscovery(event: DiscoveryEvent): void;
  getByGroup(
    groupId: string,
    options?: { limit?: number; afterOrder?: number; beforeOrder?: number },
  ): { patches: DiscoveredPatch[]; hasMore: boolean };
  getGroupIds(): string[];
  getGroupCount(groupId: string): number;
  setLastCheckpoint(seq: bigint): void;
  getLastCheckpoint(): bigint;
  getStats(): { totalGroups: number; totalPatches: number; lastCheckpoint: string };
}

// In-memory implementation for development and reference.
export class InMemoryDiscoveryStore implements DiscoveryStore {
  private groups = new Map<string, Map<string, DiscoveredPatch>>();
  private lastCheckpoint: bigint = 0n;

  // Add patches from a discovery event, deduplicating by messageId (keeps latest checkpoint).
  addDiscovery(event: DiscoveryEvent): void {
    for (const patch of event.patches) {
      let groupMap = this.groups.get(patch.groupId);
      if (!groupMap) {
        groupMap = new Map();
        this.groups.set(patch.groupId, groupMap);
      }

      const existing = groupMap.get(patch.messageId);
      if (existing) {
        const existingCheckpoint = BigInt(existing.checkpoint);
        const newCheckpoint = BigInt(patch.checkpoint);
        if (newCheckpoint > existingCheckpoint) {
          groupMap.set(patch.messageId, patch);
        }
      } else {
        groupMap.set(patch.messageId, patch);
      }
    }
  }

  // Get discovered patches for a group, sorted by order with cursor-based pagination.
  getByGroup(
    groupId: string,
    options?: {
      limit?: number;
      afterOrder?: number;
      beforeOrder?: number;
    },
  ): { patches: DiscoveredPatch[]; hasMore: boolean } {
    const groupMap = this.groups.get(groupId);
    if (!groupMap) return { patches: [], hasMore: false };

    const limit = options?.limit ?? 50;

    let patches = Array.from(groupMap.values())
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    if (options?.afterOrder !== undefined) {
      patches = patches.filter(p => (p.order ?? 0) > options.afterOrder!);
    }
    if (options?.beforeOrder !== undefined) {
      patches = patches.filter(p => (p.order ?? 0) < options.beforeOrder!);
    }

    const hasMore = patches.length > limit;
    patches = patches.slice(0, limit);

    return { patches, hasMore };
  }

  // Get all group IDs that have discovered patches.
  getGroupIds(): string[] {
    return Array.from(this.groups.keys());
  }

  // Get the number of discovered patches for a group.
  getGroupCount(groupId: string): number {
    return this.groups.get(groupId)?.size ?? 0;
  }

  // Update the last processed checkpoint sequence number.
  setLastCheckpoint(seq: bigint): void {
    this.lastCheckpoint = seq;
  }

  // Get the last processed checkpoint for health monitoring.
  getLastCheckpoint(): bigint {
    return this.lastCheckpoint;
  }

  // Get summary stats for the health endpoint.
  getStats(): { totalGroups: number; totalPatches: number; lastCheckpoint: string } {
    let totalPatches = 0;
    for (const groupMap of this.groups.values()) {
      totalPatches += groupMap.size;
    }

    return {
      totalGroups: this.groups.size,
      totalPatches,
      lastCheckpoint: this.lastCheckpoint.toString(),
    };
  }
}
