// Metrics: process-wide counters + suggestion latency percentiles, plus the
// Express middleware that times requests.
//
// This module owns the shared `metrics` singleton (imported across the codebase)
// AND exposes `metricsMiddleware`, which stamps each GET /suggest request's
// wall-clock latency so /metrics can report p50/p95/p99.

import type { Request, Response, NextFunction } from 'express';
import { performance } from 'node:perf_hooks';
import { quantile } from '../util.js';

export interface Counters {
  suggestRequests: number;
  suggestComputes: number;
  searchRequests: number;
  cacheHits: number;
  cacheMisses: number;
  dbReads: number;
  dbWrites: number;
  rawSearches: number;
  aggregatedWrites: number;
  batchFlushes: number;
  cacheInvalidations: number;
}

export interface LatencySnapshot {
  samples: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export class Metrics {
  readonly counters: Counters = {
    suggestRequests: 0,
    suggestComputes: 0,
    searchRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    dbReads: 0,
    dbWrites: 0,
    rawSearches: 0,
    aggregatedWrites: 0,
    batchFlushes: 0,
    cacheInvalidations: 0,
  };

  private lat: Float64Array;
  private latLen = 0;
  private latPos = 0;

  constructor(private latWindow = 20_000) {
    this.lat = new Float64Array(latWindow);
  }

  inc(name: keyof Counters, by = 1): void {
    this.counters[name] += by;
  }

  recordLatency(ms: number): void {
    this.lat[this.latPos] = ms;
    this.latPos = (this.latPos + 1) % this.latWindow;
    if (this.latLen < this.latWindow) this.latLen++;
  }

  latencySnapshot(): LatencySnapshot {
    const vals = Array.from(this.lat.subarray(0, this.latLen));
    if (vals.length === 0) {
      return { samples: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
    }
    const sum = vals.reduce((a, b) => a + b, 0);
    return {
      samples: vals.length,
      avgMs: +(sum / vals.length).toFixed(4),
      p50Ms: +quantile(vals, 0.5).toFixed(4),
      p95Ms: +quantile(vals, 0.95).toFixed(4),
      p99Ms: +quantile(vals, 0.99).toFixed(4),
      maxMs: +Math.max(...vals).toFixed(4),
    };
  }

  snapshot() {
    const c = this.counters;
    const lookups = c.cacheHits + c.cacheMisses;
    return {
      counters: { ...c },
      derived: {
        cacheHitRate: lookups === 0 ? 0 : +(c.cacheHits / lookups).toFixed(4),
        writeReductionFactor:
          c.aggregatedWrites === 0 ? 0 : +(c.rawSearches / c.aggregatedWrites).toFixed(2),
        dbWritesAvoided: Math.max(0, c.rawSearches - c.aggregatedWrites),
      },
      latency: this.latencySnapshot(),
    };
  }
}

export const metrics = new Metrics();

// Express middleware: time GET /suggest requests end-to-end and feed the latency
// histogram. Other routes pass through untimed.
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' && req.path === '/suggest') {
    const t0 = performance.now();
    res.on('finish', () => metrics.recordLatency(performance.now() - t0));
  }
  next();
}

export default metrics;
