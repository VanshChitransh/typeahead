// GET  /metrics       — cache hit rate, DB I/O, write reduction, latency p50/95/99
// POST /admin/flush    — force a batch flush (handy for demos)

import { Router } from 'express';
import metrics from '../middleware/metricsMiddleware.js';
import type { DistributedCache } from '../cache/DistributedCache.js';
import type { Trie } from '../data/Trie.js';
import type { Db } from '../data/db.js';
import type { BatchWriter } from '../services/BatchWriter.js';
import type { Config } from '../config.js';

export interface MetricsDeps {
  cache: DistributedCache;
  trie: Trie;
  db: Db;
  batchWriter: BatchWriter;
  config: Config;
  loadedAtStartup: number;
}

export function metricsRouter(deps: MetricsDeps): Router {
  const { cache, trie, db, batchWriter, config, loadedAtStartup } = deps;
  const router = Router();

  router.get('/metrics', (_req, res) => {
    res.json({
      ...metrics.snapshot(),
      cache: cache.report(),
      index: { trieSize: trie.size, dbRows: db.count(), loadedAtStartup },
      writes: {
        pendingInBuffer: batchWriter.pendingSize(),
        lastFlush: batchWriter.lastFlush(),
        walEnabled: config.batch.walEnabled,
      },
      config: {
        cacheNodes: config.cache.nodeIds,
        cacheTtlMs: config.cache.ttlMs,
        flushIntervalMs: config.batch.flushIntervalMs,
        maxBufferSize: config.batch.maxBufferSize,
        recencyHalfLifeSec: config.ranking.recencyHalfLifeSec,
      },
    });
  });

  router.post('/admin/flush', (_req, res) => {
    res.json({ flushed: batchWriter.flush('manual') ?? 'nothing buffered' });
  });

  return router;
}

export default metricsRouter;
