// Entry point: build components from the primary store, recover the WAL, mount
// the routes, serve the frontend, and listen. Also handles graceful shutdown so
// no buffered search is lost on Ctrl-C.

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';

import { config } from './config.js';
import { metricsMiddleware } from './middleware/metricsMiddleware.js';
import Db from './data/db.js';
import Trie from './data/Trie.js';
import DistributedCache from './cache/DistributedCache.js';
import Ranker from './services/Ranker.js';
import TrendingService from './services/TrendingService.js';
import BatchWriter from './services/BatchWriter.js';
import SuggestionService from './services/SuggestionService.js';
import { suggestRouter } from './routes/suggest.js';
import { searchRouter } from './routes/search.js';
import { trendingRouter } from './routes/trending.js';
import { cacheDebugRouter } from './routes/cacheDebug.js';
import { metricsRouter } from './routes/metrics.js';

function buildComponents() {
  const db = new Db(config.paths.db);

  // Seed the durable store from data/queries.json on first run (no-op if present).
  const seeded = db.seedFromJsonIfEmpty(config.paths.dataset);
  if (seeded > 0) console.log(`  Seeded primary store with ${seeded.toLocaleString()} queries.`);

  const trie = new Trie({ maxScanNodes: config.trie.maxScanNodes });
  const ranker = new Ranker(config.ranking);
  const trending = new TrendingService(config.trending);

  // Warm the in-memory index + trending leaderboard from the primary store.
  let loaded = 0;
  for (const row of db.iterateAll()) {
    trie.upsert(row.query, {
      count: row.count,
      recentScore: row.recentScore,
      lastSearched: row.lastSearched,
    });
    if (row.recentScore > 0) {
      trending.note({
        query: row.query,
        count: row.count,
        recentScore: row.recentScore,
        lastSearched: row.lastSearched,
      });
    }
    loaded++;
  }

  const cache = new DistributedCache({
    nodeIds: config.cache.nodeIds,
    capacityPerNode: config.cache.capacityPerNode,
    ttlMs: config.cache.ttlMs,
    virtualNodes: config.cache.virtualNodes,
  });

  const batchWriter = new BatchWriter({ db, trie, trending, cache, ranker, config });
  const suggestions = new SuggestionService({
    cache,
    trie,
    ranker,
    maxSuggestions: config.ranking.maxSuggestions,
  });

  return { db, trie, ranker, trending, cache, batchWriter, suggestions, loaded };
}

function createApp(c: ReturnType<typeof buildComponents>) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(metricsMiddleware);

  app.use(suggestRouter(c.suggestions));
  app.use(searchRouter(c.batchWriter));
  app.use(trendingRouter(c.trending, c.ranker, config.trending.size));
  app.use(cacheDebugRouter(c.cache, c.trie));
  app.use(
    metricsRouter({
      cache: c.cache,
      trie: c.trie,
      db: c.db,
      batchWriter: c.batchWriter,
      config,
      loadedAtStartup: c.loaded,
    }),
  );

  app.get('/health', (_req, res) => res.json({ status: 'ok', trieSize: c.trie.size }));

  if (fs.existsSync(config.paths.frontend)) {
    app.use(express.static(config.paths.frontend));
  }
  return app;
}

function main() {
  const c = buildComponents();

  if (c.db.count() === 0) {
    console.warn('\n  ⚠  Primary store is empty. Run `npm run generate` to create the dataset.\n');
  }

  // Replay anything a previous crash left in the WAL, BEFORE accepting new writes.
  const recovery = c.batchWriter.recover();
  if (recovery.recovered > 0) {
    console.log(`  ↻ Recovered ${recovery.recovered} searches from the WAL.`);
  }
  c.batchWriter.start();

  const app = createApp(c);
  const server = app.listen(config.port, () => {
    console.log(`\n  Search Typeahead running:  http://localhost:${config.port}`);
    console.log(`  Indexed queries:           ${c.trie.size.toLocaleString()}`);
    console.log(`  Cache nodes:               ${config.cache.nodeIds.join(', ')}`);
    console.log(
      `  Batch flush:               every ${config.batch.flushIntervalMs}ms or ` +
        `${config.batch.maxBufferSize} distinct queries\n`,
    );
  });

  const shutdown = (signal: string) => {
    console.log(`\n  ${signal} received — flushing and shutting down...`);
    server.close(() => {
      c.batchWriter.stop();
      c.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
