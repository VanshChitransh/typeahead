# Search Typeahead — HLD101 Assignment

A production-shaped **search typeahead system**: it suggests popular queries as a
user types, records searches, and is engineered around the backend data-system
concerns the assignment targets:

- a **distributed cache** sharded with **consistent hashing** for low-latency reads,
- **recency-aware trending** layered on top of all-time popularity,
- **batched writes** with a **write-ahead log (WAL)** for crash durability,
- a measurable, sub-millisecond suggestion path (latency + cache hit rate reported).

The backend is **TypeScript + Express** (run directly with `tsx`, no build step).
The frontend is plain **HTML/CSS/JS**. The primary store is **SQLite** via Node's
built-in `node:sqlite` — so the whole project runs with **zero native compilation
and no external database server**.

---

## Table of contents

1. [Quick start](#1-quick-start)
2. [Screenshots](#2-screenshots)
3. [Feature checklist (rubric mapping)](#3-feature-checklist-rubric-mapping)
4. [Tech stack & why](#4-tech-stack--why)
5. [Architecture](#5-architecture)
6. [Data model](#6-data-model)
7. [The three graded components, in depth](#7-the-three-graded-components-in-depth)
   - [7.1 Typeahead suggestions (basic)](#71-typeahead-suggestions-basic--60)
   - [7.2 Trending / recency-aware ranking](#72-trending--recency-aware-ranking--20)
   - [7.3 Batched writes + WAL](#73-batched-writes--wal--20)
8. [Consistent hashing](#8-consistent-hashing)
9. [API reference](#9-api-reference)
10. [Performance results](#10-performance-results)
11. [Configuration](#11-configuration)
12. [Project structure](#12-project-structure)
13. [Dataset](#13-dataset)
14. [How to verify it works](#14-how-to-verify-it-works)
15. [Troubleshooting](#15-troubleshooting)
16. [Design choices & trade-offs](#16-design-choices--trade-offs)
17. [Further documentation](#17-further-documentation)

---

## 1. Quick start

**Prerequisites:** Node.js **≥ 22.5** (uses the built-in `node:sqlite`; developed on
Node 25). No database server, no Docker, no native build tools required.

```bash
cd backend
npm install             # installs express + cors + dev TypeScript tooling (tsx)
npm run generate        # writes backend/data/queries.json (120k Zipf-distributed queries)
npm start               # seeds the store on first run, then serves http://localhost:3000
```

Open <http://localhost:3000> and start typing. The frontend is served by the
backend, so there is nothing else to start.

> First start seeds SQLite from `queries.json` (~0.7 s) and logs
> `Seeded primary store with 1,20,000 queries.` Subsequent starts reuse the DB file.

Useful commands (all from `backend/`):

| Command | What it does |
| --- | --- |
| `npm start` | Build the index, recover the WAL, serve the app on `:3000` |
| `npm run dev` | Same, with `tsx watch` auto-reload |
| `npm run generate` | (Re)generate `data/queries.json` |
| `npm run benchmark` | Latency, cache hit rate, write reduction, hash churn (**server must be running**) |
| `npm run demo:hashing` | Standalone consistent-hashing proof (no server needed) |
| `npm run typecheck` | `tsc --noEmit` under `strict` (zero errors) |

---

## 2. Screenshots

| Landing page | Typeahead suggestions (`sam`) |
|---|---|
| ![Landing page](screenshots/1.png) | ![Suggestions dropdown](screenshots/2.png) |
| **Search submitted — response + trending + live metrics** | **Recency-aware ranking** |
| ![After a search](screenshots/3.png) | ![Recency mode](screenshots/4.png) |
| **`GET /cache/debug` — cache miss** | **`GET /cache/debug` — cache hit** |
| ![Cache debug miss](screenshots/5.png) | ![Cache debug hit](screenshots/6.png) |
| **`GET /cache/ring` — keyspace distribution** | **`npm run demo:hashing` — consistent-hashing proof** |
| ![Cache ring](screenshots/7.png) | ![Consistent hashing demo](screenshots/8.png) |

In shot 4, recency mode promotes `running shoes review` (score 121, only 15 recent
searches) **above** `running shoes` (score 4.9, 80,250 all-time searches) — the
recency boost in action. Shots 5–6 show the same prefix routed to its owning cache
node, flipping from `MISS` to `HIT` once the prefix is warmed.

---

## 3. Feature checklist (rubric mapping)

| # | Requirement | Status | Where |
| --- | --- | :---: | --- |
| 1 | Type a prefix → up to 10 suggestions, sorted by count | ✅ | `services/SuggestionService.ts`, `data/Trie.ts` |
| 2 | Suggestions start with the prefix; case-insensitive; handles empty / no-match | ✅ | `util.ts` (normalise), `SuggestionService` |
| 3 | UI with search box + live dropdown | ✅ | `frontend/` |
| 4 | Dummy `POST /search` returning `{ "message": "Searched" }` | ✅ | `routes/search.ts` |
| 5 | Search submission updates query-count data | ✅ | `services/BatchWriter.ts` |
| 6 | Cache layer in front of the primary store, with TTL/invalidation | ✅ | `cache/DistributedCache.ts` |
| 7 | Cache **distributed** across multiple logical nodes | ✅ | `cache/DistributedCache.ts` |
| 8 | **Consistent hashing** decides which node owns a prefix | ✅ | `cache/ConsistentHashRing.ts` |
| 9 | `GET /cache/debug` shows routing + hit/miss | ✅ | `routes/cacheDebug.ts` |
| 10 | **Trending** — recency-aware ranking | ✅ | `services/Ranker.ts`, `services/TrendingService.ts` |
| 11 | **Batch writes** — buffer, aggregate, periodic/size flush | ✅ | `services/BatchWriter.ts` |
| 12 | Debounce, keyboard nav, loading/error states, trending section | ✅ | `frontend/app.js` |
| 13 | Latency (p95), cache hit rate, DB read/write counts | ✅ | `middleware/metricsMiddleware.ts`, `GET /metrics` |
| 14 | ≥ 100,000 queries with counts | ✅ | 120,000 (`scripts/generateDataset.ts`) |

**Grade breakdown the project targets:** Basic implementation (60) + Trending (20)
+ Batch writes (20).

---

## 4. Tech stack & why

| Layer | Choice | Why |
| --- | --- | --- |
| Language | **TypeScript** (run via `tsx`) | Strict types document the contracts between layers; no build step for dev |
| HTTP | **Express** | Minimal, standard routing; one router file per endpoint group |
| Primary store | **SQLite** (`node:sqlite`) | Durable source of truth with **zero** native build / external server |
| Read index | **Trie** (in-memory) | The textbook prefix structure; answers "completions of X" without disk I/O |
| Cache | **N logical LRU+TTL nodes** on a **consistent-hash ring** | Demonstrates real sharded-cache routing; runs in one process |
| Frontend | **Vanilla HTML/CSS/JS** | No framework/build; debounce + keyboard nav are hand-written and explainable |

---

## 5. Architecture

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
   │ rank (basic | recency), top-10            flush (every 2s OR 500 distinct queries)
   ▼                                                │  → SQLite upsert (one batch)
 cache.set(key, result) ──▶ return                  │  → Trie.upsert (live index)
                                                    │  → TrendingService.note
 SQLite primary store                               │  → cache.invalidate(prefixes)
   └── source of truth; seeds the Trie at start;    └── truncate WAL
       batches persist here.
```

**Three read tiers:**

| Tier | Module | Role |
| --- | --- | --- |
| Distributed cache | `cache/DistributedCache.ts` + `cache/ConsistentHashRing.ts` | Low-latency hot path; consistent hashing lives here |
| In-memory index | `data/Trie.ts` | Compute fallback on a cache miss — no disk hit |
| Primary store | `data/db.ts` (SQLite) | Durable source of truth |

The cache is consulted **before** falling back to the index (the assignment's
"cache before the primary store"). The Trie is the in-memory projection of the
store, kept hot so a miss is still microseconds rather than a disk round-trip.
Request wiring in `src/index.ts`: `cors` → `express.json` → `metricsMiddleware` →
the five routers → static `frontend/`.

For a full walkthrough see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 6. Data model

Primary store (`data/db.ts`), one SQLite table:

| column | type | meaning |
| --- | --- | --- |
| `query` | `TEXT PRIMARY KEY` | normalised query (lowercased, trimmed, single-spaced) |
| `count` | `INTEGER` | all-time search count (**never decays**) |
| `last_searched` | `INTEGER` | epoch ms of the most recent search |
| `recent_score` | `REAL` | time-decayed recency signal as of `last_searched` |

Normalisation (`util.ts`) is what gives **case-insensitive matching and
de-duplication for free**: `"iPhone"`, `"  IPHONE "`, and `"iphone"` collapse to one
key. `PRAGMA journal_mode = WAL` is SQLite's own write-ahead log (distinct from the
*application-level* WAL used for the batch buffer — same idea, different layer).

---

## 7. The three graded components, in depth

### 7.1 Typeahead suggestions (basic — 60)

A **Trie** (prefix tree) answers "give me the completions of this prefix" by walking
one node per input character; everything in that node's subtree is a completion.

**Design choice — traverse-on-demand, not top-k-per-node.** We do *not* cache a
precomputed top-k list at every node (that would cost a lot of memory across ~1M
nodes and make every count update ripple up the path). Instead, on a cache **miss**
we DFS the prefix's subtree (iterative, bounded by a scan budget), collect the
terminal entries, rank them, and return the top 10. This is cheap because the cache
absorbs the hot prefixes (≈92% hit rate) and the scan budget caps the worst case (a
cold one-character prefix over a huge subtree).

Read flow (`SuggestionService.getSuggestions`):

```
normalise prefix → cache.get("<mode>:<prefix>")
  ├─ HIT  → return cached top-10            (source: "cache")
  └─ MISS → Trie.suggest() → rank → cache.set() → return   (source: "index")
empty / missing prefix → return [] immediately (no cache, no scan)
```

### 7.2 Trending / recency-aware ranking (20)

Two ranking modes share the same `GET /suggest` endpoint via `?mode=`:

- **`basic`** — sort candidates by all-time `count`.
- **`recency`** — blend popularity with recent activity.

The recency signal is a **time-decayed counter** with a half-life `H` (default
30 min), implemented in `services/Ranker.ts`:

```
on each search:   recent = recent · 0.5^(age/H) + delta      // decay to now, then add
at ranking time:  decayedRecency = recent · 0.5^((now − last)/H)
score (recency)  = wPopularity · log10(count + 1) + wRecency · decayedRecency
```

This directly answers the assignment's required questions:

- **How are recent searches tracked?** Per-query `recent_score` + `last_searched`,
  updated on every batch flush.
- **How does recency affect ranking?** An additive, weighted term alongside
  `log10(count)`, so popularity still matters but is not absolute.
- **How is a short-lived spike kept from over-ranking forever?** Exponential decay.
  A burst inflates `recent_score`, but it halves every 30 min and fades. Permanent
  popularity lives in `count` (no decay); transient popularity lives in
  `recent_score` (decays). They are deliberately separate signals.
- **How is the cache kept correct when rankings change?** Each batch flush
  invalidates the cache keys for the affected prefixes (both modes); a 30 s TTL
  bounds the rest.
- **Freshness vs latency vs complexity trade-off:** a larger `wRecency` / shorter
  half-life = fresher but jumpier rankings and more cache churn. We re-rank a small
  candidate set **at read time** (cheap) rather than continuously re-sorting the
  whole index.

**Demonstrated (screenshot 4):** after a burst, `running shoes review` (count 60)
scores ~121 and outranks `running shoes` (count 80,250, score 4.9) in recency mode,
while basic mode keeps popularity order.

### 7.3 Batched writes + WAL (20)

Writing to the store synchronously on every `POST /search` does not scale (a viral
query is thousands of writes/sec to one row, each search paying disk latency).
Instead, `services/BatchWriter.ts`:

1. **`submit()`** appends the search to the WAL (`data/pending.wal`), then increments
   an in-memory `Map<query, count>` — **aggregating** repeats (10 searches for one
   query become a single `+10`). Returns instantly.
2. **`flush()`** (every 2 s **or** once 500 distinct queries buffer) computes the new
   count/recency, updates the Trie (the live read authority), stages **one** batched
   SQLite upsert, notes trending, invalidates affected cache prefixes, and truncates
   the WAL.

**Measured:** 20,000 searches over 40 distinct queries → **80 DB row writes** =
**250× reduction**.

**The failure trade-off (asked for explicitly):**

| approach | on crash before flush | cost |
| --- | --- | --- |
| in-memory buffer only | loses all buffered searches | fastest |
| **buffer + WAL (this project)** | loses at most the in-flight append | one small `appendFileSync` per search |
| synchronous per-search DB write | loses nothing | slowest (disk latency every search) |

The WAL is appended **before** a search is acknowledged and **replayed on startup**
(`recover()` runs before the flusher starts). Verified by `kill -9`-ing the server
with 25 un-flushed searches and confirming all 25 are recovered after restart
(`↻ Recovered 25 searches from the WAL`). `WAL_ENABLED=false` trades durability for
throughput. A graceful shutdown (SIGINT/SIGTERM) also flushes the buffer.

---

## 8. Consistent hashing

The cache is several **logical nodes** (`cache-a..d`), each an LRU cache with
per-entry TTL. A key (`"<mode>:<prefix>"`) is routed to a node by a
`ConsistentHashRing` — callers never pick a node. Each logical node maps 1:1 to what
would be a separate Redis instance in production; the ring is exactly what a
client-side sharded cache (e.g. a Redis Cluster client) computes.

**Why not `hash(key) % N`?** When `N` changes (a node joins or dies), almost every
key's `% N` result changes → the whole cache is invalidated at once → a stampede
onto the database. Consistent hashing places nodes and keys on a circle (0 .. 2³²-1)
and a key is owned by the first node **clockwise** from its hash, so a node change
only moves that node's arc — on average **~1/N** of keys. **Virtual nodes**
(150/node) smooth the otherwise-lumpy distribution.

**Measured (`npm run demo:hashing`, 100k keys):**

| | consistent hashing | naive `hash % N` |
| --- | ---: | ---: |
| keys remapped, 4 → 5 nodes | **18.7%** (ideal 20%) | **80.2%** |
| per-node ownership (4 nodes) | ~25% each | n/a |

> A real bug that was found and fixed: the first version used plain FNV-1a, and
> because virtual-node ids are sequential (`cache-a#0`, `cache-a#1`, …) and FNV-1a
> barely avalanches its last byte, one node ended up owning **41%** of the keyspace.
> Adding a murmur3 finalizer scattered the vnodes back to ~25% each. (See
> [DESIGNCHOICES.md](DESIGNCHOICES.md) §4.)

---

## 9. API reference

Base URL `http://localhost:3000`. Full details + example payloads in
[APIDOCS.md](APIDOCS.md).

| Method & path | Purpose |
| --- | --- |
| `GET /suggest?q=<prefix>&mode=basic\|recency` | Up to 10 prefix suggestions (mode picks ranking) |
| `POST /search` `{ "query": "..." }` | Record a search; returns `{ "message": "Searched", ... }` |
| `GET /cache/debug?prefix=<p>&mode=` | Which cache node owns the prefix + HIT/MISS + ring topology |
| `GET /cache/ring` | Full ring topology + per-node stats |
| `POST /cache/nodes` `{ action, node }` | Add/remove a node, report key churn (hashing demo) |
| `GET /trending?n=10` | Global trending queries by decayed recency |
| `GET /metrics` | Hit rate, DB I/O, write reduction, latency p50/p95/p99 |
| `POST /admin/flush` | Force a batch flush (demo helper) |
| `GET /health` | Liveness |

```jsonc
// GET /suggest?q=iph
{
  "prefix": "iph", "mode": "basic", "source": "index",   // or "cache"
  "suggestions": [
    { "query": "iphone", "count": 2700133, "score": 2700133 },
    { "query": "iphone 15", "count": 172409, "score": 172409 }
  ],
  "scanned": 14, "truncated": false
}

// POST /search  { "query": "iphone 15" }
{ "message": "Searched", "query": "iphone 15", "persisted": "buffered" }
```

---

## 10. Performance results

Measured on Apple Silicon, Node 25, against the 120k-query dataset. Reproduce with
`npm start` then `npm run benchmark`. Full report: [PERFORMANCEREPORT.md](PERFORMANCEREPORT.md).

| Metric | Result |
| --- | --- |
| `/suggest` throughput | 17,000–22,000 req/s (concurrency 50) |
| Cache hit rate (hot/cold mix) | **~92%** |
| Server-side suggestion latency | p50 **0.015 ms**, p95 **0.034 ms**, p99 **0.12 ms** |
| End-to-end latency (incl. HTTP) | p95 **~5–6 ms** |
| Write reduction from batching | **250×** (20,000 searches → 80 DB row writes) |
| DB reads per suggestion request | **0** (served from cache or in-memory index) |
| Consistent-hashing remap, 4→5 nodes | **18.7%** vs 80% for `hash % N` |
| WAL crash recovery | **25/25** buffered searches restored after `kill -9` |

---

## 11. Configuration

All tunables live in `backend/src/config.ts` and accept environment overrides:

| Env var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `CACHE_NODES` | `cache-a,cache-b,cache-c,cache-d` | Logical cache node ids |
| `CACHE_VNODES` | `150` | Virtual nodes per physical node |
| `CACHE_CAPACITY` | `5000` | Max entries per node before LRU eviction |
| `CACHE_TTL_MS` | `30000` | Cache entry TTL |
| `MAX_SUGGESTIONS` | `10` | Suggestions returned |
| `RECENCY_HALF_LIFE_SEC` | `1800` | Half-life of the recency signal |
| `W_POPULARITY` / `W_RECENCY` | `1.0` / `8.0` | Ranking weights |
| `TRIE_MAX_SCAN` | `50000` | Trie scan budget (worst-case bound) |
| `FLUSH_INTERVAL_MS` | `2000` | Batch flush interval |
| `MAX_BUFFER_SIZE` | `500` | Distinct-query count that forces a flush |
| `WAL_ENABLED` | `true` | Write-ahead log on/off (durability vs throughput) |
| `DATASET_SIZE` | `120000` | Number of queries the generator produces |

Example: `CACHE_TTL_MS=5000 FLUSH_INTERVAL_MS=1000 W_RECENCY=12 npm start`.

---

## 12. Project structure

```
README.md  APIDOCS.md  ARCHITECTURE.md  DESIGNCHOICES.md  PERFORMANCEREPORT.md
backend/
  data/queries.json              generated dataset (query + count); seeds the store
  package.json  tsconfig.json
  scripts/
    generateDataset.ts           synthesise 120k Zipf-distributed queries
    benchmark.ts                 performance harness (latency / hit rate / write reduction)
    demoConsistentHashing.ts     standalone hashing proof
  src/
    index.ts                     entry: build components, recover WAL, mount routes, listen
    config.ts  util.ts  types.ts shared config / helpers / domain types
    cache/
      ConsistentHashRing.ts      hash ring with virtual nodes (FNV-1a + murmur3 finalizer)
      DistributedCache.ts        LRU+TTL nodes routed by the ring
    data/
      Trie.ts                    in-memory prefix index (traverse-on-demand)
      db.ts                      SQLite primary store (node:sqlite)
    middleware/
      metricsMiddleware.ts       metrics store + request-timing middleware
    routes/
      suggest.ts search.ts trending.ts cacheDebug.ts metrics.ts
    services/
      SuggestionService.ts       cache-then-index read path
      TrendingService.ts         global recency leaderboard
      BatchWriter.ts             aggregating buffer + WAL + flusher
      Ranker.ts                  basic + recency-aware scoring
frontend/
  index.html  app.js  style.css  (debounce, keyboard nav, trending, live metrics)
screenshots/                     1.png … 8.png
```

---

## 13. Dataset

- **120,000 distinct queries**, counts following a **Zipf distribution** (a few head
  queries searched millions of times, a long low-count tail — the shape of real
  query logs, and what makes head-prefix caching so effective).
- Generated by `backend/scripts/generateDataset.ts` from a curated vocabulary
  (brands × products × modifiers, tech terms, how-to templates) into
  `backend/data/queries.json`. The generator is **deterministic** (seeded PRNG), so
  the dataset is reproducible.
- The server seeds SQLite from `queries.json` on first start.
- **To use a real dataset instead:** write any array of
  `{ "query": "...", "count": N }` to `backend/data/queries.json` (e.g. Wikipedia
  titles, an AOL query log, product names — aggregate to counts if needed), delete
  `backend/data/typeahead.db`, and restart so it re-seeds. Everything downstream is
  source-agnostic.

---

## 14. How to verify it works

```bash
# 1. Start the server
cd backend && npm run generate && npm start          # terminal 1

# 2. Typeahead (basic): top suggestions by count
curl "http://localhost:3000/suggest?q=iph"

# 3. Case-insensitive + empty-input handling
curl "http://localhost:3000/suggest?q=IPH"           # same results as "iph"
curl "http://localhost:3000/suggest?q="              # { "suggestions": [] }

# 4. Submit a search (dummy response) and see the recency effect
curl -X POST localhost:3000/search -H 'content-type: application/json' -d '{"query":"running shoes review"}'
#   repeat ~60×, then:
curl -X POST localhost:3000/admin/flush
curl "http://localhost:3000/suggest?q=running&mode=basic"     # popularity order
curl "http://localhost:3000/suggest?q=running&mode=recency"   # the bursted query jumps up

# 5. Consistent hashing: which node owns a prefix, hit/miss
curl "http://localhost:3000/cache/debug?prefix=iph"
curl "http://localhost:3000/cache/ring"

# 6. Metrics: hit rate, write reduction, p95 latency
curl "http://localhost:3000/metrics"

# 7. Full benchmark + standalone hashing proof
npm run benchmark            # terminal 2 (server up)
npm run demo:hashing
```

**WAL crash-recovery check:** start the server, submit a few searches, `kill -9` the
process before the next flush, restart — the startup log prints
`↻ Recovered N searches from the WAL` and the counts are intact.

---

## 15. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Primary store is empty` warning | Run `npm run generate` (creates `data/queries.json`), then restart |
| `ExperimentalWarning: SQLite is an experimental feature` | Expected on Node — `node:sqlite` is built-in but flagged experimental; harmless |
| Port 3000 in use | `PORT=4000 npm start` |
| Want a clean slate | Delete `backend/data/typeahead.db*` and `backend/data/pending.wal`; the store re-seeds from `queries.json` |
| Node version error | Use Node ≥ 22.5 (`node --version`) |

---

## 16. Design choices & trade-offs

A short list (full reasoning in [DESIGNCHOICES.md](DESIGNCHOICES.md)):

- **Three read tiers (cache → trie → store):** the cache delivers latency and houses
  consistent hashing; the trie is a memory-light, in-memory fallback; SQLite is the
  durable source of truth, touched only on seed and flush.
- **Traverse-on-demand trie:** light memory and zero update-ripple, at the cost of a
  larger scan on a *cold* short prefix — bounded by a scan budget and rare thanks to
  caching.
- **Logical in-process cache nodes:** one-command run while demonstrating the exact
  routing of a real sharded cache.
- **Recency as a decaying counter:** popularity and recency are separate signals, so
  a spike fades instead of over-ranking forever.
- **Batching + WAL:** trade a tiny per-search disk append for a 250× write reduction
  and crash durability.

---

## 17. Further documentation

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component-by-component design and the request wiring |
| [APIDOCS.md](APIDOCS.md) | Every endpoint with parameters and example payloads |
| [DESIGNCHOICES.md](DESIGNCHOICES.md) | Trade-offs, the consistent-hashing bug, future work |
| [PERFORMANCEREPORT.md](PERFORMANCEREPORT.md) | Full measured numbers and how to reproduce them |
