// Batched write pipeline.
//
// PROBLEM: writing to the primary store synchronously on every POST /search
// doesn't scale — a viral query means thousands of writes/sec to one row, and
// each search would pay disk latency before responding.
//
// SOLUTION: accept the search instantly, buffer it in memory, AGGREGATE repeats
// (10 searches for "iphone" => +10 in one row update), and flush periodically OR
// when the buffer is large. One DB round-trip then covers many searches.
//
// DURABILITY (the failure trade-off the assignment asks about):
// A pure in-memory buffer loses everything on a crash before a flush. We add a
// WRITE-AHEAD LOG: every search is appended to data/pending.wal BEFORE we ack it.
// On startup we replay the WAL and flush, so at most the in-flight append is at
// risk. Cost: one small synchronous disk append per search (WAL_ENABLED=false
// trades durability for throughput).

import fs from 'node:fs';
import { normalize, prefixesOf } from '../util.js';
import metrics from '../middleware/metricsMiddleware.js';
import { MODES, type Config } from '../config.js';
import type { Db } from '../data/db.js';
import type { Trie } from '../data/Trie.js';
import type { TrendingService } from './TrendingService.js';
import type { DistributedCache } from '../cache/DistributedCache.js';
import type { Ranker } from './Ranker.js';
import type { QueryEntry } from '../types.js';

export interface FlushSummary {
  at: number;
  reason: string;
  distinctQueries: number;
  cacheKeysInvalidated: number;
}

export class BatchWriter {
  private db: Db;
  private trie: Trie;
  private trending: TrendingService;
  private cache: DistributedCache;
  private ranker: Ranker;
  private cfg: Config['batch'];
  private walPath: string;

  private buffer = new Map<string, number>(); // normalised query -> pending count
  private timer: NodeJS.Timeout | null = null;
  private _lastFlush: FlushSummary | null = null;

  constructor({
    db,
    trie,
    trending,
    cache,
    ranker,
    config,
  }: {
    db: Db;
    trie: Trie;
    trending: TrendingService;
    cache: DistributedCache;
    ranker: Ranker;
    config: Config;
  }) {
    this.db = db;
    this.trie = trie;
    this.trending = trending;
    this.cache = cache;
    this.ranker = ranker;
    this.cfg = config.batch;
    this.walPath = config.paths.wal;
  }

  // Accept a search. Returns the normalised query (so callers can echo it).
  submit(rawQuery: unknown): string | null {
    const query = normalize(rawQuery);
    if (!query) return null;

    if (this.cfg.walEnabled) {
      fs.appendFileSync(this.walPath, query + '\n'); // append-before-ack
    }
    this.buffer.set(query, (this.buffer.get(query) || 0) + 1);
    metrics.inc('rawSearches');

    if (this.buffer.size >= this.cfg.maxBufferSize) this.flush('size');
    return query;
  }

  pendingSize(): number {
    return this.buffer.size;
  }

  lastFlush(): FlushSummary | null {
    return this._lastFlush;
  }

  // Persist everything buffered. Safe because the event loop is single-threaded:
  // we snapshot+clear the buffer first.
  flush(reason = 'interval'): FlushSummary | null {
    if (this.buffer.size === 0) return null;

    const pending = this.buffer;
    this.buffer = new Map();
    const now = Date.now();

    const dbItems: QueryEntry[] = [];
    const affectedPrefixes = new Set<string>();

    for (const [query, delta] of pending) {
      const prev = this.trie.getEntry(query) ?? { count: 0, recentScore: 0, lastSearched: 0 };
      const stats = {
        count: prev.count + delta,
        recentScore: this.ranker.bumpRecentScore(prev.recentScore, prev.lastSearched, delta, now),
        lastSearched: now,
      };
      this.trie.upsert(query, stats); // 1) live in-memory index (authority)
      const entry: QueryEntry = { query, ...stats };
      this.trending.note(entry); // 2) trending leaderboard
      dbItems.push(entry); // 3) stage durable write
      for (const p of prefixesOf(query, this.cfg.invalidatePrefixMaxLen)) {
        affectedPrefixes.add(p); // 4) which prefix cache keys are now stale
      }
    }

    this.db.applyBatch(dbItems); // single aggregated DB round-trip
    metrics.inc('aggregatedWrites', dbItems.length);
    metrics.inc('batchFlushes');

    let invalidated = 0;
    for (const p of affectedPrefixes) {
      for (const mode of Object.values(MODES)) {
        this.cache.invalidate(`${mode}:${p}`);
        invalidated++;
      }
    }

    if (this.cfg.walEnabled) fs.writeFileSync(this.walPath, ''); // durably persisted

    this._lastFlush = {
      at: now,
      reason,
      distinctQueries: dbItems.length,
      cacheKeysInvalidated: invalidated,
    };
    return this._lastFlush;
  }

  // Replay any WAL left by a crash, then flush it. Called once at startup, BEFORE
  // the periodic flusher starts.
  recover(): { recovered: number; flush?: FlushSummary | null } {
    if (!this.cfg.walEnabled || !fs.existsSync(this.walPath)) return { recovered: 0 };
    const lines = fs.readFileSync(this.walPath, 'utf8').split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return { recovered: 0 };
    for (const q of lines) {
      this.buffer.set(q, (this.buffer.get(q) || 0) + 1);
      metrics.inc('rawSearches');
    }
    return { recovered: lines.length, flush: this.flush('wal-recovery') };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush('interval'), this.cfg.flushIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush('shutdown');
  }
}

export default BatchWriter;
