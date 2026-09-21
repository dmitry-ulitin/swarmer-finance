import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validation';
import * as importService from '../services/import';

const router = Router();

router.use(authMiddleware);

const parseSchema = z.object({
  accountId: z.number().int().positive(),
  format: z.string().optional(),
  /** The statement file, base64. */
  content: z.string().min(1),
});

const reconcileSchema = z.object({
  accountId: z.number().int().positive(),
  rows: z.array(
    z.object({
      date: z.string(),
      amount: z.number(),
      description: z.string().optional(),
      payee: z.string().nullish(),
      hash: z.string().min(1),
      categoryId: z.number().int().positive().nullish(),
    })
  ).min(1),
});

router.post('/parse', validate(parseSchema), async (req: AuthRequest, res, next) => {
  try {
    const { accountId, format, content } = req.body;
    const result = await importService.parseStatement(req.userId!, accountId, content, format);
    res.json({ data: result, error: null });
  } catch (error) {
    next(error);
  }
});

router.post('/reconcile', validate(reconcileSchema), async (req: AuthRequest, res, next) => {
  try {
    const { accountId, rows } = req.body;
    const result = await importService.reconcile(req.userId!, accountId, rows);
    res.json({ data: result, error: null });
  } catch (error) {
    next(error);
  }
});

export default router;
