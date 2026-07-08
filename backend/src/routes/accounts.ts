import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validation';
import * as accountService from '../services/accounts';

const router = Router();

router.use(authMiddleware);

// Currency code: 3 uppercase ASCII letters (ISO 4217, e.g. USD, EUR, GBP)
// or 4 uppercase ASCII letters (crypto-style tickers like USDT, USDC).
// Mirrors the DB-level CHECK constraint chk_accounts_currency_format /
// chk_transactions_currency_format added in migration 006 — defense in
// depth so a bad value cannot reach the database even if a future
// migration or direct SQL edit bypasses the API.
const currencySchema = z
  .string()
  .regex(/^[A-Z]{3,4}$/, 'Currency must be 3 or 4 uppercase ASCII letters (e.g. USD, EUR, USDT)');

const createAccountSchema = z.object({
  name: z.string().min(1).max(255),
  currency: currencySchema,
  startBalance: z.number().default(0),
  scale: z.number().optional().default(2),
});

const updateAccountSchema = createAccountSchema.partial();

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const accounts = await accountService.getAccounts(req.userId!);
    res.json({ data: accounts, error: null });
  } catch (error) {
    next(error);
  }
});

router.post('/', validate(createAccountSchema), async (req: AuthRequest, res, next) => {
  try {
    const { name, currency, startBalance, scale } = req.body;
    const account = await accountService.createAccount(req.userId!, name, currency, startBalance, scale);
    res.json({ data: account, error: null });
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'statusCode' in error) {
      const err = error as { statusCode: number; message: string };
      return res.status(err.statusCode).json({ data: null, error: err.message });
    }
    next(error);
  }
});

router.put('/:id', validate(updateAccountSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const account = await accountService.updateAccount(id, req.userId!, req.body);
    res.json({ data: account, error: null });
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
    const result = await accountService.deleteAccount(id, req.userId!);
    res.json({ data: { success: true, kind: result.kind }, error: null });
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'statusCode' in error) {
      const err = error as { statusCode: number; message: string };
      return res.status(err.statusCode).json({ data: null, error: err.message });
    }
    next(error);
  }
});

export default router;
