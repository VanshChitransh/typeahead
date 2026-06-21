// Consistent hashing ring.
//
// PROBLEM: with several cache nodes, which node owns a given key? Naive sharding
// `hash(key) % N` breaks when N changes — adding/removing one node remaps almost
// every key, causing a cache stampede onto the database.
//
// CONSISTENT HASHING: place both nodes and keys on a circle (0 .. 2^32-1). A key
// is owned by the first node clockwise from its hash. When a node joins/leaves,
// only the keys in its arc move — on average ~1/N of all keys.
//
// VIRTUAL NODES: each physical node is placed at MANY points on the ring. This
// smooths the otherwise-lumpy distribution and shrinks the churn on a change.

// 32-bit string hash: FNV-1a to fold the bytes, then a murmur3-style finalizer to
// avalanche the bits. The finalizer matters because our virtual-node ids are
// sequential ("cache-a#0", "cache-a#1", ...) and plain FNV-1a barely mixes the
// last byte — which would cluster a node's vnodes on the ring and skew the key
// distribution. Deterministic (no Math.random) so routing is reproducible.
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // *= FNV prime, unsigned 32-bit
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

interface RingPoint {
  hash: number;
  nodeId: string;
}

export interface RingTopology {
  physicalNodes: string[];
  virtualNodesPerNode: number;
  totalRingPoints: number;
  ownershipPercent: Record<string, number>;
}

export interface KeyLocation {
  key: string;
  keyHash: number;
  owner: string | null;
  vnodeHash: number | null;
  ringSize: number;
}

export class ConsistentHashRing {
  private ring: RingPoint[] = [];
  private nodes = new Set<string>();
  readonly virtualNodes: number;

  constructor({ virtualNodes = 150 }: { virtualNodes?: number } = {}) {
    this.virtualNodes = virtualNodes;
  }

  private vnodeKey(nodeId: string, i: number): string {
    return `${nodeId}#${i}`;
  }

  private sort(): void {
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  addNode(nodeId: string): void {
    if (this.nodes.has(nodeId)) return;
    this.nodes.add(nodeId);
    for (let i = 0; i < this.virtualNodes; i++) {
      this.ring.push({ hash: fnv1a(this.vnodeKey(nodeId, i)), nodeId });
    }
    this.sort();
  }

  removeNode(nodeId: string): void {
    if (!this.nodes.has(nodeId)) return;
    this.nodes.delete(nodeId);
    this.ring = this.ring.filter((p) => p.nodeId !== nodeId);
  }

  // First vnode clockwise from the key's hash (wrapping past the top of the ring).
  private locatePoint(keyHash: number): RingPoint | null {
    if (this.ring.length === 0) return null;
    let lo = 0;
    let hi = this.ring.length - 1;
    if (keyHash > this.ring[hi].hash) return this.ring[0]; // wrap around
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].hash < keyHash) lo = mid + 1;
      else hi = mid;
    }
    return this.ring[lo];
  }

  getNode(key: string): string | null {
    const point = this.locatePoint(fnv1a(key));
    return point ? point.nodeId : null;
  }

  locate(key: string): KeyLocation {
    const keyHash = fnv1a(key);
    const point = this.locatePoint(keyHash);
    return {
      key,
      keyHash,
      owner: point ? point.nodeId : null,
      vnodeHash: point ? point.hash : null,
      ringSize: this.ring.length,
    };
  }

  // Estimate each node's share of the keyspace (sum of arc widths). The arc
  // between ring point i and i+1 belongs to point i+1's node (first node
  // clockwise from a key in that arc).
  ownershipDistribution(): Record<string, number> {
    const span = 2 ** 32;
    const share: Record<string, number> = {};
    for (const id of this.nodes) share[id] = 0;
    if (this.ring.length === 0) return share;
    for (let i = 0; i < this.ring.length; i++) {
      const cur = this.ring[i];
      const next = this.ring[(i + 1) % this.ring.length];
      let arc = next.hash - cur.hash;
      if (arc <= 0) arc += span;
      share[next.nodeId] += arc;
    }
    const pct: Record<string, number> = {};
    for (const id of this.nodes) pct[id] = +((share[id] / span) * 100).toFixed(2);
    return pct;
  }

  topology(): RingTopology {
    return {
      physicalNodes: [...this.nodes],
      virtualNodesPerNode: this.virtualNodes,
      totalRingPoints: this.ring.length,
      ownershipPercent: this.ownershipDistribution(),
    };
  }
}

export default ConsistentHashRing;
