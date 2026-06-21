# Design Choices & Trade-offs

The decisions you'd defend in a design review (and the assignment viva). Pairs with
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Three read tiers (cache → trie → store)

- **Cache** delivers the low latency the assignment asks for and is where
  consistent hashing lives. The query stream is Zipf-distributed, so a few hot
  prefixes serve most traffic from cache.
- **Trie** is the compute fallback: an in-memory index so a miss is microseconds,
  not a disk round-trip.
- **SQLite** is the durable source of truth, touched only on seed and on batch
  flush — never per suggestion request.

Trade-off: the Trie duplicates the store's data in memory. We accept the memory
for the latency, and rebuild it from the store at startup so it's never the
authority for durability.

---

## 2. Trie: traverse-on-demand, not top-k-per-node

A common optimisation caches a precomputed top-k list at every node. We don't:

1. Over ~1M nodes, top-k arrays cost a lot of memory, and every count update would
   ripple up the path fixing them.
2. The cache already absorbs hot prefixes (92% hit rate), so we rarely compute.
3. A scan budget (`config.trie.maxScanNodes`) bounds the worst case (a cold
   1-character prefix over a huge subtree).

Trade-off accepted: a *cold* very short prefix scans more nodes than a top-k design
would — but it's rare (cache + Zipf) and bounded, in exchange for far less memory
and zero update-ripple cost.

---

## 3. Logical (in-process) cache nodes

Running the cache nodes as in-process objects keeps the project to one command
while demonstrating the exact routing a real sharded cache uses. Each logical node
maps 1:1 to a Redis instance in production; the consistent-hash ring is precisely
what a Redis Cluster client computes. Swapping in real Redis wouldn't change the
routing code.

---

## 4. Consistent hashing over `hash % N` — and a real bug we fixed

`hash(key) % N` remaps ~all keys when N changes → a cache stampede onto the DB.
Consistent hashing moves only ~1/N. Virtual nodes (150/node) smooth the per-node
share. Measured: adding a 5th node remaps **18.7%** of keys (ideal 20%) vs **80%**
for modulo.

**The bug:** the first version used plain FNV-1a. Because virtual-node ids are
sequential (`cache-a#0`, `cache-a#1`, …) and FNV-1a barely avalanches its last
byte, a node's vnodes clustered on the ring and one node owned **41%** of the
keyspace. Adding a murmur3 finalizer scattered them back to ~25% each.
**Lesson: consistent hashing is only as good as the hash's avalanche on
near-identical inputs.**

---

## 5. Recency-aware ranking (the trending 20%)

Recency is a **time-decayed counter** with a half-life H (30 min):

```
on each search:  recent = recent · 0.5^(age/H) + delta     // decay, then add
at rank time:    decayedRecency = recent · 0.5^((now−last)/H)
score (recency mode) = wPopularity·log10(count+1) + wRecency·decayedRecency
```

Answering the assignment's required questions:
- **How are recent searches tracked?** Per-query `recent_score` + `last_searched`,
  updated on each batch flush.
- **How does recency affect ranking?** An additive, weighted term alongside
  `log10(count)` so popularity still matters but isn't absolute.
- **How is a brief spike kept from over-ranking forever?** Decay. The spike
  inflates `recent_score`, but it halves every 30 min and fades. Permanent
  popularity lives in `count` (no decay); transient popularity in `recent_score`
  (decays). They're deliberately separate signals.
- **How is the cache kept correct when rankings change?** Flush invalidates the
  affected prefix keys; TTL bounds the rest.
- **Trade-offs (freshness vs latency vs complexity)?** Bigger `wRecency`/shorter
  half-life = fresher but jumpier rankings and more cache churn. We re-rank a small
  candidate set *at read time* (cheap) rather than continuously re-sorting the whole
  index, accepting that `recent_score` is "as of the last flush" and is decayed
  forward at read time.

Demonstrated live: after a burst, `running shoes review` (count 60) scores 481.8
and outranks `running shoes` (count 80,250, score 4.9) in recency mode, while basic
mode keeps popularity order.

---

## 6. Batched writes + WAL (the batch-writes 20%)

Synchronous per-search DB writes don't scale (a viral query = thousands of
writes/sec to one row, each search paying disk latency). Instead we buffer,
**aggregate** repeats (10 searches → one `+10`), and flush in batches. Measured:
20,000 searches → 80 DB writes (**250×** fewer).

**The failure trade-off (asked for explicitly):**

| approach | on crash before flush | cost |
| --- | --- | --- |
| in-memory buffer only | loses all buffered searches | fastest |
| **buffer + WAL (ours)** | loses at most the in-flight append | one small `appendFileSync` per search |
| synchronous per-search DB write | loses nothing | slowest (disk latency every search) |

We append to `data/pending.wal` before acknowledging a search and replay it on
startup. Verified by `kill -9`-ing the server with 25 un-flushed searches and
confirming all 25 are recovered after restart. `WAL_ENABLED=false` trades
durability for throughput — the choice made explicit. Graceful shutdown
(SIGINT/SIGTERM) flushes the buffer too, so the normal case loses nothing either.

---

## 7. Synthetic dataset

A generated 120k-query Zipf corpus is allowed by the assignment and makes the repo
self-contained (no large download). Counts decay by rank so head prefixes dominate
— which is exactly what makes the cache effective. Any real `query,count` dataset
drops in by replacing `backend/data/queries.json`.

---

## 8. Known limitations / future work
- Logical cache nodes are in-process; production would point the ring at real
  Redis instances with replication per ring position.
- The Trie holds the whole corpus in one process; sharding the index (e.g. by first
  character) would scale it horizontally.
- Recency is re-ranked over a candidate set at read time; an extreme-freshness SLA
  might warrant a streaming top-k structure instead.
