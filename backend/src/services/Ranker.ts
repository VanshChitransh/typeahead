// Ranking: how a set of candidate completions is ordered. Shared by the
// SuggestionService (prefix ranking) and the TrendingService (global ranking).
//
// BASIC (60% rubric): sort by all-time `count`. Historically popular wins.
//
// ENHANCED / recency-aware (20% rubric): blend popularity with recent activity so
// a query surging right now can outrank a stale giant. The recency signal is a
// TIME-DECAYED COUNTER with a half-life:
//   on each search:  recent = recent * 0.5^(age/H) + delta   (decay, then add)
//   at rank time:    decayedRecency = recent * 0.5^((now-last)/H)
//
// WHY:
//   * Permanent popularity lives in `count` (never decays); transient popularity
//     lives in `recentScore` (halves every H). A brief spike fades on its own, so
//     it can't permanently over-rank a query.
//   * log10(count) keeps a mega-popular query from drowning out a newcomer.

import { cmpStr } from '../util.js';
import type { Mode, QueryEntry, RankedSuggestion } from '../types.js';

export interface RankerConfig {
  recencyHalfLifeSec: number;
  wPopularity: number;
  wRecency: number;
}

export class Ranker {
  private halfLifeSec: number;
  private wPopularity: number;
  private wRecency: number;
  private ln2 = Math.LN2;

  constructor(cfg: RankerConfig) {
    this.halfLifeSec = cfg.recencyHalfLifeSec;
    this.wPopularity = cfg.wPopularity;
    this.wRecency = cfg.wRecency;
  }

  private decayFactor(ageMs: number): number {
    if (ageMs <= 0) return 1;
    return Math.exp((-this.ln2 * (ageMs / 1000)) / this.halfLifeSec);
  }

  // Decay a stored recent_score forward to `now`.
  decayedRecency(recentScore: number, lastSearched: number, now: number): number {
    if (!recentScore) return 0;
    return recentScore * this.decayFactor(now - lastSearched);
  }

  // Fold `delta` new searches into the recency counter as of `now`.
  bumpRecentScore(prevRecent: number, prevLast: number, delta: number, now: number): number {
    return this.decayedRecency(prevRecent, prevLast, now) + delta;
  }

  combinedScore(entry: QueryEntry, now: number): number {
    const recency = this.decayedRecency(entry.recentScore, entry.lastSearched, now);
    return this.wPopularity * Math.log10(entry.count + 1) + this.wRecency * recency;
  }

  // Order a candidate list; returns a new array annotated with the score used.
  rank(entries: QueryEntry[], mode: Mode, now: number): RankedSuggestion[] {
    if (mode === 'recency') {
      return entries
        .map((e) => ({ ...e, score: +this.combinedScore(e, now).toFixed(4) }))
        .sort((a, b) => b.score - a.score || b.count - a.count || cmpStr(a.query, b.query));
    }
    return entries
      .map((e) => ({ ...e, score: e.count }))
      .sort((a, b) => b.count - a.count || cmpStr(a.query, b.query));
  }
}

export default Ranker;
