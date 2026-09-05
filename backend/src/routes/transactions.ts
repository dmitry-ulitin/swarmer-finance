import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validation';
import * as transactionService from '../services/transactions';
import { TransactionFilters } from '../db/queries/transactions';

const router = Router();

router.use(authMiddleware);

const createTransactionSchema = z.object({
  categoryId: z.number().int().positive().nullish(),
  debitAccountId: z.number().int().positive().nullish(),
  creditAccountId: z.number().int().positive().nullish(),
  debit: z.number().positive(),
  credit: z.number().positive(),
  date: z.string(),
  description: z.string().nullish(),
  payee: z.string().nullish(),
});

const updateTransactionSchema = createTransactionSchema.partial();

const arrayOfIds = z.preprocess(
  (val) => (Array.isArray(val) ? val : val !== undefined ? [val] : undefined),
  z.array(z.coerce.number().int().positive()).optional()
);

const filtersSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  category: arrayOfIds,
  account: arrayOfIds,
  details: z.string().optional(),
  type: z.enum(['income', 'expense', 'transfer']).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const toIntArray = (val: unknown): number[] | undefined => {
  if (!val) return undefined;
  const arr = Array.isArray(val) ? val : [val];
  const nums = (arr as string[]).map(v => parseInt(v, 10)).filter(n => !isNaN(n));
  return nums.length ? nums : undefined;
};

router.get('/', validate(filtersSchema, 'query'), async (req: AuthRequest, res, next) => {
  try {
    const filters: TransactionFilters = {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      category: toIntArray(req.query.category),
      account: toIntArray(req.query.account),
      details: req.query.details as string | undefined,
      type: req.query.type as 'income' | 'expense' | 'transfer' | undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };
    const result = await transactionService.getTransactions(req.userId!, filters);
    res.json({ data: result, error: null });
  } catch (error) {
    next(error);
  }
});

router.post('/', validate(createTransactionSchema), async (req: AuthRequest, res, next) => {
  try {
    const transaction = await transactionService.createTransaction(req.userId!, req.body);
    res.json({ data: transaction, error: null });
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'statusCode' in error) {
      const err = error as { statusCode: number; message: string };
      return res.status(err.statusCode).json({ data: null, error: err.message });
    }
    next(error);
  }
});

router.put('/:id', validate(updateTransactionSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const transaction = await transactionService.updateTransaction(id, req.userId!, req.body);
    res.json({ data: transaction, error: null });
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'statusCode' in error) {
      const err = error as { statusCode: number; message: string };
      return res.status(err.statusCode).json({ data: null, error: err.message });
    }
    next(error);
  }
});

router.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    await transactionService.deleteTransaction(id, req.userId!);
    res.json({ data: { success: true }, error: null });
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'statusCode' in error) {
      const err = error as { statusCode: number; message: string };
      return res.status(err.statusCode).json({ data: null, error: err.message });
    }
    next(error);
  }
});

export default router;
