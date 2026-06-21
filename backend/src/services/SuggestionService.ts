// Suggestion read path, tying the layers together:
//
//   request -> normalise prefix -> distributed cache  (HIT -> return fast)
//                                       |  MISS
//                                       v
//                              in-memory Trie index  (rank -> cache -> return)
//
// The cache is consulted BEFORE the index (the assignment's "cache before falling
// back to the primary data store"). The Trie is the in-memory projection of the
// primary store, kept hot so a miss never has to touch disk.

import metrics from '../middleware/metricsMiddleware.js';
import { normalize } from '../util.js';
import { MODES } from '../config.js';
import type { DistributedCache } from '../cache/DistributedCache.js';
import type { Trie } from '../data/Trie.js';
import type { Ranker } from './Ranker.js';
import type { LeanSuggestion, Mode, SuggestResult } from '../types.js';

export class SuggestionService {
  private cache: DistributedCache;
  private trie: Trie;
  private ranker: Ranker;
  private limit: number;

  constructor({
    cache,
    trie,
    ranker,
    maxSuggestions,
  }: {
    cache: DistributedCache;
    trie: Trie;
    ranker: Ranker;
    maxSuggestions: number;
  }) {
    this.cache = cache;
    this.trie = trie;
    this.ranker = ranker;
    this.limit = maxSuggestions;
  }

  getSuggestions(rawPrefix: unknown, rawMode: unknown): SuggestResult {
    metrics.inc('suggestRequests');

    const mode: Mode = rawMode === MODES.RECENCY ? MODES.RECENCY : MODES.BASIC;
    const prefix = normalize(rawPrefix);

    // Graceful handling of empty / missing input: no cache, no scan.
    if (!prefix) return { prefix: '', mode, source: 'empty', suggestions: [] };

    const cacheKey = `${mode}:${prefix}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return { prefix, mode, source: 'cache', suggestions: cached };
    }

    // Miss: compute from the in-memory index and populate the cache.
    metrics.inc('suggestComputes');
    const now = Date.now();
    const { suggestions, scanned, truncated } = this.trie.suggest(prefix, {
      limit: this.limit,
      ranker: this.ranker,
      mode,
      now,
    });

    const lean: LeanSuggestion[] = suggestions.map((s) => ({
      query: s.query,
      count: s.count,
      score: s.score,
    }));
    this.cache.set(cacheKey, lean);

    return { prefix, mode, source: 'index', suggestions: lean, scanned, truncated };
  }
}

export default SuggestionService;
