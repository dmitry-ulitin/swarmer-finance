import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { isoDateSchema, validate } from '../middleware/validation';
import * as importService from '../services/import';
import { requireBankSync } from '../services/bank/crypto';
import { loadFromBank } from '../services/bank/links';

const router = Router();

router.use(authMiddleware);

const parseSchema = z.object({
  accountId: z.number().int().positive(),
  format: z.string().optional(),
  /** The statement file, base64. */
  content: z.string().min(1),
});

const bankLoadSchema = z.object({
  accountId: z.number().int().positive(),
  /** First load only: where the window starts (default today − 90 days). */
  dateFrom: isoDateSchema.optional(),
});

const reconcileSchema = z.object({
  accountId: z.number().int().positive(),
  /** Set when confirming a bank load: the window's end, the new "loaded up to" marker. */
  bankLoadedTo: isoDateSchema.optional(),
  rows: z.array(
    z.object({
      date: isoDateSchema,
      amount: z.number(),
      description: z.string().optional(),
      payee: z.string().nullish(),
      hash: z.string().min(1),
      categoryId: z.number().int().positive().nullish(),
      transferAccountId: z.number().int().positive().nullish(),
    })
  ),
}).refine((b) => b.rows.length > 0 || b.bankLoadedTo !== undefined, {
  path: ['rows'],
  message: 'At least one row is required',
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

router.post('/bank', validate(bankLoadSchema), async (req: AuthRequest, res, next) => {
  try {
    requireBankSync();
    const { accountId, dateFrom } = req.body;
    // The user's own address for the bank: the client end of X-Forwarded-For.
    const forwarded = req.get('X-Forwarded-For')?.split(',')[0]?.trim();
    const psu = { ip: forwarded || req.ip, userAgent: req.get('User-Agent') };
    const result = await loadFromBank(req.userId!, accountId, { dateFrom, psu });
    res.json({ data: result, error: null });
  } catch (error) {
    next(error);
  }
});

router.post('/reconcile', validate(reconcileSchema), async (req: AuthRequest, res, next) => {
  try {
    const { accountId, rows, bankLoadedTo } = req.body;
    const result = await importService.reconcile(req.userId!, accountId, rows, { bankLoadedTo });
    res.json({ data: result, error: null });
  } catch (error) {
    next(error);
  }
});

export default router;
