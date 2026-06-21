// Global trending leaderboard (powers GET /trending).
//
// /suggest is prefix-scoped; trending is global ("what's hot right now across
// everything?"). Scanning 100k+ rows per request is wasteful, so we keep a
// bounded set of recently-active queries (only queries that get searched ever
// enter it) and rank them by decayed recency on demand. If it exceeds
// `maxTracked`, the entries with the lowest stored recency are evicted.

import type { Ranker } from './Ranker.js';
import type { QueryEntry } from '../types.js';

export interface TrendingItem extends QueryEntry {
  recency: number;
}

export class TrendingService {
  private maxTracked: number;
  private defaultSize: number;
  private entries = new Map<string, QueryEntry>();

  constructor({ maxTracked = 5000, size = 10 }: { maxTracked?: number; size?: number } = {}) {
    this.maxTracked = maxTracked;
    this.defaultSize = size;
  }

  // Called by the batch writer for each query touched in a flush.
  note(entry: QueryEntry): void {
    this.entries.set(entry.query, { ...entry });
    if (this.entries.size > this.maxTracked) this.evict();
  }

  private evict(): void {
    const arr = [...this.entries.values()].sort((a, b) => a.recentScore - b.recentScore);
    const dropCount = Math.ceil(this.maxTracked * 0.1);
    for (let i = 0; i < dropCount && i < arr.length; i++) this.entries.delete(arr[i].query);
  }

  // Top trending queries, ranked by decayed recency as of `now`.
  top(ranker: Ranker, now: number, n = this.defaultSize): TrendingItem[] {
    const scored: TrendingItem[] = [];
    for (const e of this.entries.values()) {
      const recency = ranker.decayedRecency(e.recentScore, e.lastSearched, now);
      if (recency <= 0) continue;
      scored.push({ ...e, recency: +recency.toFixed(4) });
    }
    scored.sort((a, b) => b.recency - a.recency || b.count - a.count);
    return scored.slice(0, n);
  }

  get tracked(): number {
    return this.entries.size;
  }
}

export default TrendingService;
