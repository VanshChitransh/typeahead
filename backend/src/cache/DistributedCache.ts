// The distributed cache: a set of logical cache NODES (each an LRU cache with
// per-entry TTL) with keys routed to nodes by a ConsistentHashRing.
//
// Callers never pick a node — the ring does, keyed by the cache key
// (e.g. "recency:iphone"). This is exactly how a client-side sharded cache (a
// Redis Cluster client) behaves. Each logical node maps 1:1 to what would be a
// separate Redis instance in production; running them in-process keeps the
// project to a single command while demonstrating the same routing.

import ConsistentHashRing, { type RingTopology } from './ConsistentHashRing.js';
import metrics from '../middleware/metricsMiddleware.js';
import type { LeanSuggestion, Mode } from '../types.js';

type CacheValue = LeanSuggestion[];

interface NodeStats {
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  sets: number;
}

interface NodeReport extends NodeStats {
  id: string;
  size: number;
  capacity: number;
  ttlMs: number;
}

// One logical cache node. LRU via Map insertion order: a Map iterates oldest-first,
// so on read we delete+reinsert (mark MRU) and on overflow evict the first key.
class CacheNode {
  readonly id: string;
  readonly capacity: number;
  readonly ttlMs: number;
  private map = new Map<string, { value: CacheValue; expiresAt: number }>();
  private stats: NodeStats = { hits: 0, misses: 0, evictions: 0, expirations: 0, sets: 0 };

  constructor(id: string, { capacity, ttlMs }: { capacity: number; ttlMs: number }) {
    this.id = id;
    this.capacity = capacity;
    this.ttlMs = ttlMs;
  }

  get(key: string, now = Date.now()): CacheValue | undefined {
    const hit = this.map.get(key);
    if (!hit) {
      this.stats.misses++;
      return undefined;
    }
    if (hit.expiresAt <= now) {
      this.map.delete(key);
      this.stats.expirations++;
      this.stats.misses++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit); // mark most-recently-used
    this.stats.hits++;
    return hit.value;
  }

  set(key: string, value: CacheValue, now = Date.now()): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: now + this.ttlMs });
    this.stats.sets++;
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
      this.stats.evictions++;
    }
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  // Non-mutating presence check (respects TTL) — used by /cache/debug so that
  // inspecting the cache doesn't itself count as a hit/miss.
  peek(key: string, now = Date.now()): boolean {
    const hit = this.map.get(key);
    return !!hit && hit.expiresAt > now;
  }

  clear(): void {
    this.map.clear();
  }

  report(): NodeReport {
    return {
      id: this.id,
      size: this.map.size,
      capacity: this.capacity,
      ttlMs: this.ttlMs,
      ...this.stats,
    };
  }
}

export interface RouteInfo {
  mode: Mode;
  cacheKey: string;
  keyHash: number;
  ownerNode: string | null;
  vnodeHash: number | null;
  status: 'HIT' | 'MISS';
  ownerNodeStats: NodeReport | null;
}

export interface ChurnReport {
  sampledKeys: number;
  keysRemapped: number;
  remapFraction: number;
}

export interface ClusterReport {
  topology: RingTopology;
  totals: { size: number; hits: number; misses: number; evictions: number; expirations: number };
  nodes: NodeReport[];
}

export class DistributedCache {
  private ring: ConsistentHashRing;
  private nodes = new Map<string, CacheNode>();
  private capacityPerNode: number;
  private ttlMs: number;

  constructor({
    nodeIds,
    capacityPerNode,
    ttlMs,
    virtualNodes,
  }: {
    nodeIds: string[];
    capacityPerNode: number;
    ttlMs: number;
    virtualNodes: number;
  }) {
    this.ring = new ConsistentHashRing({ virtualNodes });
    this.capacityPerNode = capacityPerNode;
    this.ttlMs = ttlMs;
    for (const id of nodeIds) this.addNodeInternal(id);
  }

  private addNodeInternal(id: string): void {
    this.nodes.set(id, new CacheNode(id, { capacity: this.capacityPerNode, ttlMs: this.ttlMs }));
    this.ring.addNode(id);
  }

  nodeFor(key: string): CacheNode | null {
    const id = this.ring.getNode(key);
    return id ? this.nodes.get(id) ?? null : null;
  }

  get(key: string): CacheValue | undefined {
    const node = this.nodeFor(key);
    if (!node) return undefined;
    const value = node.get(key);
    if (value === undefined) metrics.inc('cacheMisses');
    else metrics.inc('cacheHits');
    return value;
  }

  set(key: string, value: CacheValue): void {
    this.nodeFor(key)?.set(key, value);
  }

  invalidate(key: string): void {
    const node = this.nodeFor(key);
    if (node && node.delete(key)) metrics.inc('cacheInvalidations');
  }

  // Rich routing info for GET /cache/debug — "which node owns this prefix, and is
  // it currently a hit or a miss?" without mutating stats.
  route(mode: Mode, cacheKey: string): RouteInfo {
    const located = this.ring.locate(cacheKey);
    const node = located.owner ? this.nodes.get(located.owner) ?? null : null;
    return {
      mode,
      cacheKey,
      keyHash: located.keyHash,
      ownerNode: located.owner,
      vnodeHash: located.vnodeHash,
      status: node && node.peek(cacheKey) ? 'HIT' : 'MISS',
      ownerNodeStats: node ? node.report() : null,
    };
  }

  // --- Demonstrating consistent hashing: add/remove a node, report churn ---
  addNode(id: string, sampleKeys: string[] = []): ChurnReport {
    const before = sampleKeys.map((k) => this.ring.getNode(k));
    this.addNodeInternal(id);
    const after = sampleKeys.map((k) => this.ring.getNode(k));
    return this.churn(sampleKeys, before, after);
  }

  removeNode(id: string, sampleKeys: string[] = []): ChurnReport {
    const before = sampleKeys.map((k) => this.ring.getNode(k));
    this.nodes.get(id)?.clear();
    this.nodes.delete(id);
    this.ring.removeNode(id);
    const after = sampleKeys.map((k) => this.ring.getNode(k));
    return this.churn(sampleKeys, before, after);
  }

  private churn(keys: string[], before: (string | null)[], after: (string | null)[]): ChurnReport {
    let moved = 0;
    for (let i = 0; i < keys.length; i++) if (before[i] !== after[i]) moved++;
    return {
      sampledKeys: keys.length,
      keysRemapped: moved,
      remapFraction: keys.length ? +(moved / keys.length).toFixed(4) : 0,
    };
  }

  report(): ClusterReport {
    const perNode = [...this.nodes.values()].map((n) => n.report());
    const totals = perNode.reduce(
      (acc, n) => {
        acc.size += n.size;
        acc.hits += n.hits;
        acc.misses += n.misses;
        acc.evictions += n.evictions;
        acc.expirations += n.expirations;
        return acc;
      },
      { size: 0, hits: 0, misses: 0, evictions: 0, expirations: 0 },
    );
    return { topology: this.ring.topology(), totals, nodes: perNode };
  }
}

export default DistributedCache;
