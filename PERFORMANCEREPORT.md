# Performance Report

Measured on the reference machine (Apple Silicon, macOS, Node v25.1.0) against a
**120,000-query** dataset, TypeScript build run via `tsx`. Reproduce:

```bash
cd backend
npm run generate && npm start     # terminal 1
npm run benchmark                 # terminal 2
npm run demo:hashing              # standalone hashing proof
```

Harness: `backend/scripts/benchmark.ts`. Live numbers always at `GET /metrics`.

---

## 1. Suggestion latency (`GET /suggest`)

8,000 requests, concurrency 50, 80% hot prefixes / 20% cold.

| mode | throughput | cache hit rate | server p50 | server p95 | server p99 | client p95 (incl. HTTP) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| basic | 17,296 req/s | 92.3% | 0.0154 ms | 0.0340 ms | 0.1218 ms | 5.98 ms |
| recency | 22,474 req/s | 92.1% | 0.0144 ms | 0.0282 ms | 0.0998 ms | 5.24 ms |

- **Server-side** latency (from `metricsMiddleware`, which times the full Express
  handler) stays well under 0.05 ms at p95 — a cache hit returns in tens of
  microseconds; even the p99, which includes cold-prefix Trie scans, is ~0.1 ms.
- **Client-side** latency includes the loopback HTTP round-trip and 50 concurrent
  connections through single-threaded Node — that's the ~5 ms p95. It's the honest
  end-to-end figure; the server-side number is what the data structures cost.
- **92% cache hit rate** is the headline: Zipf-distributed traffic means a few hot
  prefixes serve most requests straight from the consistent-hashed cache.

---

## 2. Cache effectiveness & DB I/O (`GET /metrics`)

- Cache hit rate ~92% under the hot/cold mix.
- **DB reads:** one bulk read at startup to build the Trie. **Zero disk reads per
  suggestion request.**
- **DB writes:** only batch flushes (below).

---

## 3. Write reduction from batching (`POST /search`)

20,000 submissions over 40 distinct queries, then a forced flush:

| metric | value |
| --- | ---: |
| raw searches accepted | 20,000 |
| DB row writes performed | 80 |
| **write reduction** | **250×** |
| writes avoided | 19,920 |

Aggregation (repeats → one row update) and batching (many rows → one transaction)
compound. Tune via `FLUSH_INTERVAL_MS` / `MAX_BUFFER_SIZE`.

---

## 4. Consistent hashing (`npm run demo:hashing`, 100,000 keys)

| property | consistent hashing | naive `hash % N` |
| --- | ---: | ---: |
| keys remapped, 4 → 5 nodes | **18.69%** (ideal 20%) | **80.18%** |
| per-node ownership (4 nodes) | 27.6 / 21.7 / 25.3 / 25.4 % | n/a |

Adding a node moves only the new node's arc; the others keep their warm caches.
Modulo reshuffles ~80% — a stampede onto the DB. The in-server churn check
(`POST /cache/nodes`) reports ~20% on a sample of live prefix keys.

> An earlier build using plain FNV-1a (no avalanche finalizer) skewed one node to
> **41%** ownership; the murmur3 finalizer fixed it. See DESIGNCHOICES §4.

---

## 5. Crash durability (WAL)

Auto-flush disabled, submit 25 searches for a new query, `kill -9`, restart:

| step | observation |
| --- | --- |
| after 25 submits | `data/pending.wal` holds 25 lines |
| after `kill -9` | WAL still on disk (25 lines) |
| after restart | log: `↻ Recovered 25 searches from the WAL` |
| recovered term | `count = 25` (fully restored) |
| WAL after recovery | truncated to 0 bytes |

No acknowledged write lost across a hard crash. Cost: one `appendFileSync` per
search (`WAL_ENABLED=false` trades durability for throughput).

---

## 6. Startup & footprint
- **Seed:** 120,000 rows from `queries.json` into SQLite in ~0.7 s (first run only).
- **Index build:** Trie built from the store at startup; ready in well under a
  second after seeding.
- **Memory:** traverse-on-demand Trie stores structure + terminal entries only (no
  per-node top-k), keeping the footprint modest for 120k queries.

---

## 7. Pushing the numbers further
- `CACHE_CAPACITY` ↑ / `CACHE_TTL_MS` ↓ — trade memory/freshness for hit rate.
- `CACHE_VNODES` ↑ — tighter key distribution.
- `FLUSH_INTERVAL_MS` ↓ — fresher counts, more DB writes.
- Point the ring at real Redis to scale the cache tier horizontally (routing code
  unchanged).
