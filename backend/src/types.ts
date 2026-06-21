// Shared domain types used across the cache, index, ranking, and write layers.

export type Mode = 'basic' | 'recency';

// A query as stored in the index/primary store.
export interface QueryEntry {
  query: string;
  count: number; // all-time search count (never decays)
  recentScore: number; // time-decayed recency signal as of `lastSearched`
  lastSearched: number; // epoch ms of the most recent search
}

// The mutable count/recency fields without the query string (used on upsert).
export type EntryStats = Omit<QueryEntry, 'query'>;

// A query entry annotated with the score used to rank it.
export interface RankedSuggestion extends QueryEntry {
  score: number;
}

// A ranked suggestion returned to the client.
export interface LeanSuggestion {
  query: string;
  count: number;
  score: number;
}

export interface SuggestResult {
  prefix: string;
  mode: Mode;
  source: 'cache' | 'index' | 'empty';
  suggestions: LeanSuggestion[];
  scanned?: number;
  truncated?: boolean;
}
