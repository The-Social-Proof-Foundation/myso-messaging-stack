import express from 'express';
import type { DiscoveryStore } from './discovery-store.js';

// Create the Express app with REST endpoints for querying discovered patches.
export function createApp(store: DiscoveryStore): express.Application {
  const app = express();

  // GET /v1/groups/:groupId/patches — discovered patches for a group with pagination.
  app.get('/v1/groups/:groupId/patches', (req, res) => {
    const { groupId } = req.params;

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const afterOrder = req.query.after_order
      ? parseInt(req.query.after_order as string)
      : undefined;
    const beforeOrder = req.query.before_order
      ? parseInt(req.query.before_order as string)
      : undefined;

    const { patches, hasMore } = store.getByGroup(groupId, {
      limit,
      afterOrder,
      beforeOrder,
    });

    res.json({
      groupId,
      count: patches.length,
      hasMore,
      patches,
    });
  });

  // GET /v1/patches — all discovered patches across all groups.
  app.get('/v1/patches', (req, res) => {
    const groupIdFilter = req.query.groupId as string | undefined;

    if (groupIdFilter) {
      const { patches, hasMore } = store.getByGroup(groupIdFilter);
      res.json({ count: patches.length, hasMore, patches });
      return;
    }

    const groupIds = store.getGroupIds();
    const groups: Record<string, { count: number }> = {};
    let totalCount = 0;

    for (const groupId of groupIds) {
      const count = store.getGroupCount(groupId);
      groups[groupId] = { count };
      totalCount += count;
    }

    res.json({
      totalGroups: groupIds.length,
      totalPatches: totalCount,
      groups,
    });
  });

  // GET /health — health check with last processed checkpoint and discovery stats.
  app.get('/health', (_req, res) => {
    const stats = store.getStats();

    res.json({
      status: 'ok',
      lastCheckpoint: stats.lastCheckpoint,
      totalGroups: stats.totalGroups,
      totalPatches: stats.totalPatches,
    });
  });

  return app;
}
