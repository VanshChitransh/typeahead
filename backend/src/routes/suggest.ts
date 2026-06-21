// GET /suggest?q=<prefix>&mode=basic|recency  — typeahead suggestions.

import { Router } from 'express';
import type { SuggestionService } from '../services/SuggestionService.js';

export function suggestRouter(suggestions: SuggestionService): Router {
  const router = Router();
  router.get('/suggest', (req, res) => {
    res.json(suggestions.getSuggestions(req.query.q ?? '', req.query.mode));
  });
  return router;
}

export default suggestRouter;
