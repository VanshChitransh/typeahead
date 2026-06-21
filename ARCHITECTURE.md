# Architecture

How the system fits together. For the *why* behind each choice, see
[DESIGNCHOICES.md](DESIGNCHOICES.md).

---

## 1. The big picture

```
 Read path (GET /suggest)                      Write path (POST /search)
 ────────────────────────                      ─────────────────────────
 client                                          client
   │ normalise prefix                              │ submit(query)
   ▼                                                ▼
 DistributedCache  ──HIT──▶ return               BatchWriter
   │ MISS                                           │  1. append to WAL (durable)
   ▼                                                │  2. buffer[query] += 1 (aggregate)
 Trie index (in-memory)                             ▼
   │ rank (basic|recency), top-10               flush (every 2s OR 500 distinct)
   ▼                                                │  → SQLite upsert (one batch)
 cache.set(key, result) ──▶ return                  │  → Trie.upsert (live index)
                                                    │  → TrendingService.note
 SQLite primary store (data/db.ts)                  │  → cache.invalidate(prefixes)
   └── source of truth; seeds the Trie at start;    └── truncate WAL
       batches persist here.
```

The three read tiers and where they live:

| tier | module | role |
| --- | --- | --- |
| Distributed cache | `cache/DistributedCache.ts` + `cache/ConsistentHashRing.ts` | low-latency hot path; consistent hashing |
| In-memory index | `data/Trie.ts` | compute fallback on a miss (no disk hit) |
| Primary store | `data/db.ts` (SQLite) | durable source of truth |

Request wiring (`src/index.ts`): `cors` → `express.json` → `metricsMiddleware`
→ the five routers (`routes/*.ts`) → static `frontend/`.

---

## 2. Data model

`data/db.ts`, one SQLite table:

| column | type | meaning |
| --- | --- | --- |
| `query` | TEXT PK | normalised query (lowercased, trimmed, single-spaced) |
| `count` | INTEGER | all-time search count (never decays) |
| `last_searched` | INTEGER | epoch ms of the most recent search |
| `recent_score` | REAL | time-decayed recency signal as of `last_searched` |

Normalisation (`util.ts`) gives case-insensitive matching + de-duplication for
free. `PRAGMA journal_mode=WAL` is SQLite's own write-ahead log (distinct from our
*application* WAL for the batch buffer — same idea, different layer).

On first start, `db.seedFromJsonIfEmpty()` loads `data/queries.json` in one
transaction; thereafter the DB file persists and seeding is skipped.

---

## 3. Trie (prefix index) — `data/Trie.ts`

Walk one node per input character to the prefix's node; the subtree under it holds
all completions. We use **traverse-on-demand**: on a cache miss we DFS the subtree
(iterative, scan-budget-bounded), collect terminal entries, and rank them. We do
*not* cache top-k per node — see DESIGNCHOICES §2 for why (memory + update cost).

---

## 4. Distributed cache — `cache/`

`DistributedCache` owns several logical `CacheNode`s (each an **LRU + per-entry
TTL** cache) and a `ConsistentHashRing`. A key (`"<mode>:<prefix>"`) is routed to a
node by the ring — callers never pick a node. Each logical node maps 1:1 to what
would be a separate Redis instance in production.

**Consistent hashing** places nodes + keys on a circle (0..2³²-1); a key is owned
by the first node clockwise from its hash. Adding/removing a node moves only that
node's arc (~1/N of keys), not nearly all of them as `hash % N` would. **Virtual
nodes** (150/node) smooth the distribution. The hash is FNV-1a + a murmur3
finalizer (DESIGNCHOICES §4 explains why the finalizer is load-bearing).

**Invalidation:** TTL (30 s) bounds staleness; on each batch flush we also delete
the cache keys for every prefix of each updated query (both modes), capped at 15
chars.

---

## 5. Ranking & trending — `services/Ranker.ts`, `services/TrendingService.ts`

`Ranker` is shared:
- **basic** → sort by `count`.
- **recency** → `wPopularity·log10(count+1) + wRecency·decayedRecency`, where the
  recency signal is a time-decayed counter with a 30-min half-life.

`TrendingService` keeps a bounded global leaderboard of recently-active queries
(only searched queries enter it) and ranks them by decayed recency on demand.

---

## 6. Batched writes — `services/BatchWriter.ts`

`submit()` appends to the WAL (`data/pending.wal`) and increments an in-memory
`Map<query, count>` (aggregation). `flush()` (every 2 s or 500 distinct queries)
computes new count/recency, updates the Trie (live authority), stages one batched
SQLite upsert, notes trending, invalidates affected cache prefixes, and truncates
the WAL. `recover()` replays the WAL on startup before the flusher starts.

---

## 7. Observability — `middleware/metricsMiddleware.ts`

Owns the shared `metrics` singleton (counters + a latency ring buffer) and the
Express middleware that times `GET /suggest` requests end-to-end. `GET /metrics`
exposes the snapshot plus cache, index, and write-pipeline state.

---

## 8. Why TypeScript here

Strict typing makes the layer contracts explicit: `QueryEntry`, `Mode`,
`LeanSuggestion`, and the route `Deps` interfaces document exactly what flows
between cache, index, ranker, and writer. We run the `.ts` directly with `tsx`
(esbuild under the hood) — no separate build step for development — and
`tsc --noEmit` (strict, no-unused) gates type errors.
