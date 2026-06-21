// Cache routing/debug endpoints — the evidence for the consistent-hashing rubric.
//   GET  /cache/debug?prefix=&mode=  -> which node owns the prefix + hit/miss
//   GET  /cache/ring                 -> full ring topology + per-node stats
//   POST /cache/nodes                -> add/remove a node, report key churn

import { Router } from 'express';
import { normalize } from '../util.js';
import { MODES } from '../config.js';
import type { DistributedCache } from '../cache/DistributedCache.js';
import type { Trie, TrieNode } from '../data/Trie.js';
import type { Mode } from '../types.js';

// Pull a spread of representative cache keys (first/second-level prefixes) so the
// node add/remove demo measures churn against realistic keys.
function sampleCacheKeys(trie: Trie, max: number): string[] {
  const keys: string[] = [];
  const visit = (node: TrieNode, prefix: string): void => {
    if (keys.length >= max) return;
    if (prefix.length >= 1) keys.push(`basic:${prefix}`);
    for (const [ch, child] of node.children) {
      if (keys.length >= max) break;
      if (prefix.length < 2) visit(child, prefix + ch);
    }
  };
  visit(trie.rootNode, '');
  return keys;
}

export function cacheDebugRouter(cache: DistributedCache, trie: Trie): Router {
  const router = Router();

  router.get('/cache/debug', (req, res) => {
    const mode: Mode = req.query.mode === MODES.RECENCY ? MODES.RECENCY : MODES.BASIC;
    const prefix = normalize(req.query.prefix ?? req.query.q ?? '');
    res.json({
      prefix,
      ...cache.route(mode, `${mode}:${prefix}`),
      ringTopology: cache.report().topology,
    });
  });

  router.get('/cache/ring', (_req, res) => res.json(cache.report()));

  // Body: { "action": "add"|"remove", "node": "cache-e" }
  router.post('/cache/nodes', (req, res) => {
    const { action, node } = req.body || {};
    if (!node || !['add', 'remove'].includes(action)) {
      res.status(400).json({ error: 'expected { action: add|remove, node }' });
      return;
    }
    const sampleKeys = sampleCacheKeys(trie, 2000);
    const churn =
      action === 'add' ? cache.addNode(node, sampleKeys) : cache.removeNode(node, sampleKeys);
    res.json({ action, node, churn, topology: cache.report().topology });
  });

  return router;
}

export default cacheDebugRouter;
