import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { handleMessage } from '../services/agent.js';
import { llmConfigured, llmChain } from '../services/llm.js';
import { AppError } from '../middleware/error.js';

const router = Router();

router.get('/status', (_req: Request, res: Response) => {
  res.json({ configured: llmConfigured(), models: llmConfigured() ? llmChain().length : 0 });
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const message =
      typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) throw new AppError(400, 'message is required');
    if (message.length > 2000) throw new AppError(400, 'message is too long');

    const result = await handleMessage(message);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;