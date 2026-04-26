import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validation';
import * as transactionService from '../services/transactions';

const router = Router();

router.use(authMiddleware);

const createTransactionSchema = z.object({
  categoryId: z.number().int().positive().optional(),
  debitAccountId: z.number().int().positive().optional(),
  creditAccountId: z.number().int().positive().optional(),
  debit: z.number().positive(),
  credit: z.number().positive(),
  currency: z.string().min(1).optional(),
  date: z.string(),
  description: z.string().optional(),
  payee: z.string().optional(),
});

const updateTransactionSchema = createTransactionSchema.partial();

const filtersSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  category: z.coerce.number().int().positive().optional(),
  type: z.enum(['income', 'expense', 'transfer']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

router.get('/', validate(filtersSchema), async (req: AuthRequest, res, next) => {
  try {
    const filters = {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      category: req.query.category ? parseInt(req.query.category as string, 10) : undefined,
      type: req.query.type as 'income' | 'expense' | 'transfer' | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
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
    const id = parseInt(req.params.id, 10);
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
    const id = parseInt(req.params.id, 10);
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
