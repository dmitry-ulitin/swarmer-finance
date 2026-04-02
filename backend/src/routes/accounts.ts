import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validation';
import * as accountService from '../services/accounts';

const router = Router();

router.use(authMiddleware);

const createAccountSchema = z.object({
  name: z.string().min(1),
  currency: z.string().min(1),
  startBalance: z.number().default(0),
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
    const { name, currency, startBalance } = req.body;
    const account = await accountService.createAccount(req.userId!, name, currency, startBalance);
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
    const id = parseInt(req.params.id, 10);
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
    const id = parseInt(req.params.id, 10);
    await accountService.deleteAccount(id, req.userId!);
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
