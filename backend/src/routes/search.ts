// POST /search  — dummy search submission; records the query via the batched
// write pipeline and returns the assignment's required dummy response.

import { Router } from 'express';
import metrics from '../middleware/metricsMiddleware.js';
import type { BatchWriter } from '../services/BatchWriter.js';

export function searchRouter(batchWriter: BatchWriter): Router {
  const router = Router();
  router.post('/search', (req, res) => {
    metrics.inc('searchRequests');
    const raw = (req.body && req.body.query) ?? req.query.q ?? '';
    const query = batchWriter.submit(raw);
    if (!query) {
      res.status(400).json({ message: 'Bad Request', error: 'empty query' });
      return;
    }
    // The count update is async — it becomes visible after the next batch flush.
    res.json({ message: 'Searched', query, persisted: 'buffered' });
  });
  return router;
}

export default searchRouter;
