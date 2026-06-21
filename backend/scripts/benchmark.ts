// Performance harness. Run the server first (`npm start`), then `npm run benchmark`.
//
// Produces the numbers the performance report needs:
//   1. /suggest latency (server-side p50/p95/p99 + cache hit rate)
//   2. Write reduction from batching (raw searches vs persisted DB rows)
//   3. Consistent-hashing churn when a cache node is added
//
// Uses only Node's global fetch — no extra dependencies.

import { quantile } from '../src/util.js';

const BASE = process.env.BASE || 'http://localhost:3000';

async function getJSON<T = any>(url: string): Promise<T> {
  const res = await fetch(BASE + url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}
async function postJSON<T = any>(url: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

// Run `tasks` with bounded concurrency.
async function pool(tasks: Array<() => Promise<unknown>>, concurrency: number): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < tasks.length) await tasks[i++]();
  });
  await Promise.all(workers);
}

const HOT = ['i', 'ip', 'iph', 'sam', 'nik', 'java', 'rea', 'doc', 'best', 'how', 'a', 'b', 'c'];
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const randCold = () => LETTERS[(Math.random() * 26) | 0] + LETTERS[(Math.random() * 26) | 0];

async function benchSuggest(mode: 'basic' | 'recency', requests = 8000, concurrency = 50): Promise<void> {
  console.log(`\n── 1. /suggest latency (${requests} requests, concurrency ${concurrency}, mode=${mode}) ──`);
  const before = await getJSON(`/metrics`);
  const clientLat: number[] = [];
  const tasks: Array<() => Promise<unknown>> = [];
  for (let n = 0; n < requests; n++) {
    const q = Math.random() < 0.8 ? HOT[(Math.random() * HOT.length) | 0] : randCold();
    tasks.push(async () => {
      const t = performance.now();
      await getJSON(`/suggest?q=${encodeURIComponent(q)}&mode=${mode}`);
      clientLat.push(performance.now() - t);
    });
  }
  const t0 = performance.now();
  await pool(tasks, concurrency);
  const wall = performance.now() - t0;
  const after = await getJSON(`/metrics`);

  const hits = after.counters.cacheHits - before.counters.cacheHits;
  const misses = after.counters.cacheMisses - before.counters.cacheMisses;
  const hitRate = hits + misses ? ((hits / (hits + misses)) * 100).toFixed(1) : '0';

  console.log(`  throughput          : ${(requests / (wall / 1000)).toFixed(0)} req/s`);
  console.log(`  cache hit rate      : ${hitRate}%  (${hits} hits / ${misses} misses)`);
  console.log(`  server p50/p95/p99  : ${after.latency.p50Ms} / ${after.latency.p95Ms} / ${after.latency.p99Ms} ms`);
  console.log(`  client p50/p95/p99  : ${quantile(clientLat, 0.5).toFixed(3)} / ${quantile(clientLat, 0.95).toFixed(3)} / ${quantile(clientLat, 0.99).toFixed(3)} ms (incl. HTTP)`);
}

async function benchWriteReduction(submissions = 20000, distinct = 40, concurrency = 50): Promise<void> {
  console.log(`\n── 2. Batched-write reduction (${submissions} searches over ${distinct} distinct queries) ──`);
  const queries = Array.from({ length: distinct }, (_, i) => `benchmark query ${i}`);
  const before = await getJSON(`/metrics`);
  const tasks: Array<() => Promise<unknown>> = [];
  for (let n = 0; n < submissions; n++) {
    const q = queries[(Math.random() * distinct) | 0];
    tasks.push(() => postJSON('/search', { query: q }));
  }
  await pool(tasks, concurrency);
  await postJSON('/admin/flush', {});

  const after = await getJSON(`/metrics`);
  const raw = after.counters.rawSearches - before.counters.rawSearches;
  const writes = after.counters.aggregatedWrites - before.counters.aggregatedWrites;
  console.log(`  raw searches accepted   : ${raw.toLocaleString()}`);
  console.log(`  DB row writes performed : ${writes.toLocaleString()}`);
  console.log(`  write reduction         : ${writes ? (raw / writes).toFixed(1) : '∞'}×  (${(raw - writes).toLocaleString()} writes avoided)`);
}

async function demoHashingChurn(): Promise<void> {
  console.log('\n── 3. Consistent-hashing churn (adding a 5th cache node) ──');
  const topoBefore = (await getJSON(`/cache/ring`)).topology;
  console.log('  ownership % before:', JSON.stringify(topoBefore.ownershipPercent));
  const r = await postJSON('/cache/nodes', { action: 'add', node: 'cache-bench-e' });
  console.log(`  keys remapped       : ${(r.churn.remapFraction * 100).toFixed(1)}% of ${r.churn.sampledKeys} sampled keys`);
  console.log('  ownership % after :', JSON.stringify(r.topology.ownershipPercent));
  await postJSON('/cache/nodes', { action: 'remove', node: 'cache-bench-e' });
  console.log('  (removed cache-bench-e to restore the original ring)');
  console.log(`  NOTE: with N→N+1 nodes, ideal remap ≈ 1/(N+1) = 20%. Naive hash%N would remap ~80%.`);
}

async function main(): Promise<void> {
  try {
    await getJSON(`/health`);
  } catch {
    console.error(`✗ Server not reachable at ${BASE}. Start it with \`npm start\` first.`);
    process.exit(1);
  }
  await benchSuggest('basic');
  await benchSuggest('recency');
  await benchWriteReduction();
  await demoHashingChurn();
  console.log('\n✓ Benchmark complete. Full live numbers: GET /metrics\n');
}

main();
