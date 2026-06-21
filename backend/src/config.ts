// Central configuration. Everything tunable lives here so the rest of the code
// reads as plain logic. Values accept environment overrides, which makes it easy
// to demo different behaviours (tiny batch size, single cache node, ...) without
// editing code.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mode } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(BACKEND_ROOT, '..');
const DATA_DIR = path.join(BACKEND_ROOT, 'data');

const num = (envName: string, fallback: number): number =>
  process.env[envName] !== undefined ? Number(process.env[envName]) : fallback;

export const config = {
  port: num('PORT', 3000),

  paths: {
    backendRoot: BACKEND_ROOT,
    dataDir: DATA_DIR,
    db: path.join(DATA_DIR, 'typeahead.db'),
    dataset: path.join(DATA_DIR, 'queries.json'),
    wal: path.join(DATA_DIR, 'pending.wal'),
    frontend: path.join(PROJECT_ROOT, 'frontend'),
  },

  // ---- Distributed cache (logical nodes on a consistent-hashing ring) ----
  cache: {
    // Each id models a separate cache server (think: a Redis instance).
    nodeIds: (process.env.CACHE_NODES || 'cache-a,cache-b,cache-c,cache-d')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Virtual nodes per physical node. More vnodes => smoother key distribution
    // and smaller remap when a node joins/leaves.
    virtualNodes: num('CACHE_VNODES', 150),
    // Max entries each node holds before LRU eviction kicks in.
    capacityPerNode: num('CACHE_CAPACITY', 5000),
    // Time-to-live for a cached suggestion list (ms). Bounds staleness even if
    // targeted invalidation misses something.
    ttlMs: num('CACHE_TTL_MS', 30_000),
  },

  // ---- Suggestion ranking ----
  ranking: {
    maxSuggestions: num('MAX_SUGGESTIONS', 10),
    // Half-life of the recency signal in seconds: a query's recency boost halves
    // every `recencyHalfLifeSec`. This is what stops a short-lived spike from
    // ranking high forever.
    recencyHalfLifeSec: num('RECENCY_HALF_LIFE_SEC', 1800), // 30 min
    // Weight of all-time popularity vs recent activity in the enhanced ranking.
    wPopularity: num('W_POPULARITY', 1.0),
    wRecency: num('W_RECENCY', 8.0),
  },

  // ---- Trie traversal guard ----
  trie: {
    // Upper bound on nodes visited for one suggestion computation. Protects the
    // worst case (a 1-character prefix over a huge subtree on a cold cache).
    maxScanNodes: num('TRIE_MAX_SCAN', 50_000),
  },

  // ---- Batched writes ----
  batch: {
    flushIntervalMs: num('FLUSH_INTERVAL_MS', 2_000),
    maxBufferSize: num('MAX_BUFFER_SIZE', 500),
    // Write-ahead log so buffered (not-yet-persisted) searches survive a crash.
    walEnabled: process.env.WAL_ENABLED !== 'false',
    // How deep to invalidate prefix cache keys for an updated query.
    invalidatePrefixMaxLen: num('INVALIDATE_PREFIX_MAX_LEN', 15),
  },

  // ---- Trending leaderboard ----
  trending: {
    maxTracked: num('TRENDING_MAX_TRACKED', 5_000),
    size: num('TRENDING_SIZE', 10),
  },
};

export const MODES: Record<'BASIC' | 'RECENCY', Mode> = { BASIC: 'basic', RECENCY: 'recency' };

export type Config = typeof config;
export default config;
