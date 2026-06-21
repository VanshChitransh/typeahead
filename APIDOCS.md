# API Documentation

Base URL: `http://localhost:3000`. All responses are JSON. CORS is enabled, so the
frontend can also be served from a different origin during development.

---

## `GET /suggest`
Typeahead suggestions for a prefix.

| query param | type | default | notes |
| --- | --- | --- | --- |
| `q` | string | `""` | the prefix; normalised (trimmed, lowercased) |
| `mode` | `basic` \| `recency` | `basic` | ranking mode |

- Returns at most 10 suggestions, each starting with the prefix.
- `basic` sorts by all-time `count`; `recency` by a recency-aware score.
- Empty/missing `q` returns `{ suggestions: [] }` without touching cache or index.
- Matching is case-insensitive.

```jsonc
// GET /suggest?q=iph
{
  "prefix": "iph",
  "mode": "basic",
  "source": "index",            // "cache" on a hit, "index" on a miss, "empty" if no prefix
  "suggestions": [
    { "query": "iphone", "count": 2700133, "score": 2700133 },
    { "query": "iphone 15", "count": 172409, "score": 172409 },
    { "query": "iphone charger", "count": 89429, "score": 89429 }
  ],
  "scanned": 14,                 // trie nodes visited (present only on a miss)
  "truncated": false             // true if the scan budget was hit
}
```

---

## `POST /search`
Submit a search. Records it through the batched write pipeline and returns the
required dummy response.

Body: `{ "query": "iphone 15" }` (also accepts `?q=` as a fallback).

```jsonc
{ "message": "Searched", "query": "iphone 15", "persisted": "buffered" }
```

- The count update is asynchronous — visible in suggestions/trending after the
  next flush (≤ 2 s, or immediately via `POST /admin/flush`).
- Empty query → `400 { "message": "Bad Request", "error": "empty query" }`.

---

## `GET /cache/debug`
Which cache node owns a prefix key, and whether it's currently cached.

| query param | type | default |
| --- | --- | --- |
| `prefix` (or `q`) | string | `""` |
| `mode` | `basic` \| `recency` | `basic` |

```jsonc
// GET /cache/debug?prefix=iph
{
  "prefix": "iph",
  "mode": "basic",
  "cacheKey": "basic:iph",
  "keyHash": 4153801945,
  "ownerNode": "cache-a",
  "vnodeHash": 4160100923,
  "status": "HIT",               // HIT | MISS (non-mutating peek; respects TTL)
  "ownerNodeStats": { "id": "cache-a", "size": 12, "hits": 30, "misses": 5, "...": "..." },
  "ringTopology": {
    "physicalNodes": ["cache-a", "cache-b", "cache-c", "cache-d"],
    "virtualNodesPerNode": 150,
    "totalRingPoints": 600,
    "ownershipPercent": { "cache-a": 27.7, "cache-b": 25.43, "cache-c": 25.31, "cache-d": 21.56 }
  }
}
```

---

## `GET /cache/ring`
Full ring topology + per-node cache stats and totals.

## `POST /cache/nodes`
Add or remove a logical cache node and report how few keys remapped
(consistent-hashing demo).

Body: `{ "action": "add" | "remove", "node": "cache-e" }`

```jsonc
{
  "action": "add",
  "node": "cache-e",
  "churn": { "sampledKeys": 2000, "keysRemapped": 412, "remapFraction": 0.206 },
  "topology": { "...": "..." }
}
```

---

## `GET /trending`
Global trending queries, ranked by decayed recency as of now.

| query param | type | default |
| --- | --- | --- |
| `n` | number | 10 |

```jsonc
{
  "now": 1782074354798,
  "trending": [
    { "query": "running shoes review", "count": 61, "recentScore": 60.99, "lastSearched": 1782074342875, "recency": 60.72 }
  ],
  "tracked": 1
}
```

---

## `GET /metrics`
Cache hit rate, DB read/write counts, write-reduction factor, and suggestion
latency percentiles, plus cache + index + write-pipeline state.

```jsonc
{
  "counters": { "suggestRequests": 8000, "cacheHits": 7381, "cacheMisses": 619,
                "rawSearches": 20000, "aggregatedWrites": 80, "...": "..." },
  "derived": { "cacheHitRate": 0.923, "writeReductionFactor": 250, "dbWritesAvoided": 19920 },
  "latency": { "samples": 8000, "p50Ms": 0.0154, "p95Ms": 0.034, "p99Ms": 0.1218, "maxMs": 1.9 },
  "cache": { "topology": { "..." : "..." }, "totals": { "..." : "..." }, "nodes": [ "..." ] },
  "index": { "trieSize": 120000, "dbRows": 120000, "loadedAtStartup": 120000 },
  "writes": { "pendingInBuffer": 0, "lastFlush": { "..." : "..." }, "walEnabled": true },
  "config": { "cacheNodes": ["cache-a","..."], "flushIntervalMs": 2000, "...": "..." }
}
```

---

## Helper endpoints
- `POST /admin/flush` — force a batch flush (useful in demos).
- `GET /health` — liveness: `{ "status": "ok", "trieSize": 120000 }`.
