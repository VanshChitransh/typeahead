// GET /trending?n=10  — global trending queries, ranked by decayed recency.

import { Router } from 'express';
import type { TrendingService } from '../services/TrendingService.js';
import type { Ranker } from '../services/Ranker.js';

export function trendingRouter(
  trending: TrendingService,
  ranker: Ranker,
  defaultSize: number,
): Router {
  const router = Router();
  router.get('/trending', (req, res) => {
    const n = Number(req.query.n) || defaultSize;
    const now = Date.now();
    res.json({ now, trending: trending.top(ranker, now, n), tracked: trending.tracked });
  });
  return router;
}

export default trendingRouter;
