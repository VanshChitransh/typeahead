// Standalone proof that consistent hashing does what we claim — no server needed.
//
//   npm run demo:hashing
//
// Shows (a) keys spread evenly across nodes, and (b) when a node joins, only
// ~1/(N+1) of keys move — versus naive `hash % N` which reshuffles almost
// everything. This is the log/evidence the assignment asks for.

import { ConsistentHashRing, fnv1a } from '../src/cache/ConsistentHashRing.js';

const NUM_KEYS = 100_000;
const keys = Array.from({ length: NUM_KEYS }, (_, i) => `recency:prefix-${i}`);

function distribution(ring: ConsistentHashRing): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const k of keys) {
    const node = ring.getNode(k)!;
    counts[node] = (counts[node] || 0) + 1;
  }
  return counts;
}

function pct(counts: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(counts)) out[k] = ((v / NUM_KEYS) * 100).toFixed(2) + '%';
  return out;
}

console.log(`Consistent hashing demo over ${NUM_KEYS.toLocaleString()} keys\n`);

const ring = new ConsistentHashRing({ virtualNodes: 150 });
['cache-a', 'cache-b', 'cache-c', 'cache-d'].forEach((n) => ring.addNode(n));

console.log('1) Key distribution across 4 nodes (150 vnodes each):');
console.table(pct(distribution(ring)));

const ownerBefore = keys.map((k) => ring.getNode(k));
ring.addNode('cache-e');
const ownerAfter = keys.map((k) => ring.getNode(k));
let moved = 0;
for (let i = 0; i < keys.length; i++) if (ownerBefore[i] !== ownerAfter[i]) moved++;

console.log('\n2) After adding cache-e (4 -> 5 nodes):');
console.table(pct(distribution(ring)));
console.log(`   Keys remapped (consistent hashing): ${((moved / NUM_KEYS) * 100).toFixed(2)}%`);
console.log(`   Ideal for 4->5 nodes              : ${(100 / 5).toFixed(2)}%`);

const naiveBefore = keys.map((k) => fnv1a(k) % 4);
const naiveAfter = keys.map((k) => fnv1a(k) % 5);
let naiveMoved = 0;
for (let i = 0; i < keys.length; i++) if (naiveBefore[i] !== naiveAfter[i]) naiveMoved++;
console.log(`\n3) Naive hash % N for the same 4 -> 5 change:`);
console.log(`   Keys remapped (hash % N): ${((naiveMoved / NUM_KEYS) * 100).toFixed(2)}%  <-- cache stampede`);

console.log('\nTakeaway: consistent hashing moves ~1/(N+1) of keys; modulo moves ~80%.');
