// In-memory prefix index (Trie / prefix tree).
//
// A typeahead query is "give me the completions of this prefix". A trie answers
// that by walking one node per input character to the prefix's node; everything
// in that node's subtree is a completion.
//
// DESIGN CHOICE — traverse-on-demand (not top-k cached per node):
// We do NOT store a precomputed top-k list at every node (that would cost a lot
// of memory over ~1M nodes and make every count update ripple up the path).
// Instead, on a cache MISS we walk the prefix's subtree and rank the completions
// on the fly. This is cheap because (1) the distributed cache absorbs the hot
// prefixes, and (2) a scan budget bounds the worst case (a short prefix over a
// huge subtree on a cold cache). Net: light memory + work only on a miss.

import type { EntryStats, Mode, QueryEntry, RankedSuggestion } from '../types.js';
import type { Ranker } from '../services/Ranker.js';

class TrieNode {
  children = new Map<string, TrieNode>();
  entry: QueryEntry | null = null;
}

export interface SuggestOptions {
  limit: number;
  ranker: Ranker;
  mode: Mode;
  now: number;
}

export interface SuggestOutput {
  suggestions: RankedSuggestion[];
  scanned: number;
  truncated: boolean;
}

export class Trie {
  private root = new TrieNode();
  private _size = 0;
  private maxScanNodes: number;

  constructor({ maxScanNodes = 50_000 }: { maxScanNodes?: number } = {}) {
    this.maxScanNodes = maxScanNodes;
  }

  get size(): number {
    return this._size;
  }

  // Exposed for the cache-key sampling used by the consistent-hashing demo.
  get rootNode(): TrieNode {
    return this.root;
  }

  private descend(key: string, create: boolean): TrieNode | null {
    let node = this.root;
    for (const ch of key) {
      let next = node.children.get(ch);
      if (!next) {
        if (!create) return null;
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
    }
    return node;
  }

  // Set absolute count/recency for a query (used at startup and on batch flush).
  upsert(query: string, stats: EntryStats): QueryEntry {
    const node = this.descend(query, true)!;
    if (!node.entry) this._size++;
    node.entry = { query, ...stats };
    return node.entry;
  }

  getEntry(query: string): QueryEntry | null {
    const node = this.descend(query, false);
    return node ? node.entry : null;
  }

  // Collect every completion of `prefix` (bounded by the scan budget), then let
  // the ranker order them and trim to `limit`.
  suggest(prefix: string, opts: SuggestOptions): SuggestOutput {
    const start = this.descend(prefix, false);
    if (!start) return { suggestions: [], scanned: 0, truncated: false };

    const collected: QueryEntry[] = [];
    let scanned = 0;
    let truncated = false;
    const stack: TrieNode[] = [start]; // iterative DFS (no recursion-depth risk)
    while (stack.length) {
      const node = stack.pop()!;
      scanned++;
      if (node.entry) collected.push(node.entry);
      if (scanned >= this.maxScanNodes) {
        truncated = true;
        break;
      }
      for (const child of node.children.values()) stack.push(child);
    }

    const ranked = opts.ranker.rank(collected, opts.mode, opts.now);
    return { suggestions: ranked.slice(0, opts.limit), scanned, truncated };
  }
}

export type { TrieNode };
export default Trie;
