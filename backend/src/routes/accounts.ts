import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validation';
import * as accountService from '../services/accounts';
import * as chainSync from '../services/chainSync';

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

// No `.default({})` here: create and update need different defaulting
// behavior (see createAccountSchema and updateAccountSchema below), so each
// applies its own default at the point of use.
const settingsByType = {
  cash: z.strictObject({}),
  bank: z.strictObject({
    accountNumber: z.string().max(64).optional(),
  }),
  crypto: z.strictObject({
    address: z.string().max(128).optional(),
    blockchain: z.string().max(64).optional(),
  }),
};

// Base fields are spread into each union member rather than combined with
// `.and()`: a ZodIntersection parses both sides independently and merges
// them, so the strict settings object never sees a cross-type key and
// `{ type: 'cash', settings: { accountNumber } }` would be accepted.
const createBase = {
  name: z.string().min(1).max(255),
  currency: currencySchema,
  startBalance: z.number().default(0),
};

// A discriminated union can't default a missing discriminant itself, so a
// request that omits `type` entirely is preprocessed to `type: 'cash'`
// before the union runs.
const createAccountSchema = z.preprocess(
  (val) =>
    val && typeof val === 'object' && !('type' in val) ? { ...val, type: 'cash' } : val,
  z.discriminatedUnion('type', [
    z.strictObject({ ...createBase, type: z.literal('cash'), settings: settingsByType.cash.default({}) }),
    z.strictObject({ ...createBase, type: z.literal('bank'), settings: settingsByType.bank.default({}) }),
    z.strictObject({ ...createBase, type: z.literal('crypto'), settings: settingsByType.crypto.default({}) }),
  ])
);

// A discriminated union cannot be `.partial()` — the discriminant must be
// present — so PUT requires `type` on every request. The account form always
// submits its full value, so no caller is affected.
const updateBase = {
  name: z.string().min(1).max(255).optional(),
  currency: currencySchema.optional(),
  startBalance: z.number().optional(),
};

// Unlike create, `settings` has NO default here — it is required on every
// PUT. updateAccount (db/queries/accounts.ts) writes settings wholesale, not
// COALESCEd, so a PUT that omitted settings would silently wipe out whatever
// was previously stored (e.g. a bank account's accountNumber) instead of
// leaving it untouched. Requiring the field forces callers to state intent;
// sending `settings: {}` explicitly still clears it.
const updateAccountSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...updateBase, type: z.literal('cash'), settings: settingsByType.cash }),
  z.strictObject({ ...updateBase, type: z.literal('bank'), settings: settingsByType.bank }),
  z.strictObject({ ...updateBase, type: z.literal('crypto'), settings: settingsByType.crypto }),
]);

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
    const { name, currency, startBalance, type, settings } = req.body;
    const account = await accountService.createAccount(req.userId!, name, currency, startBalance, type, settings);
    res.json({ data: account, error: null });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', validate(updateAccountSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const account = await accountService.updateAccount(id, req.userId!, req.body);
    res.json({ data: account, error: null });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id/transactions', async (req: AuthRequest, res, next) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const result = await accountService.purgeAccount(id, req.userId!, false);
    res.json({ data: result, error: null });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (req.query.withTransactions === 'true') {
      const purged = await accountService.purgeAccount(id, req.userId!, true);
      res.json({ data: { success: true, kind: 'purged', ...purged }, error: null });
      return;
    }
    const result = await accountService.deleteAccount(id, req.userId!);
    res.json({ data: { success: true, kind: result.kind }, error: null });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/sync', async (req: AuthRequest, res, next) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const result = await chainSync.syncAccount(req.userId!, id);
    res.json({ data: result, error: null });
  } catch (error) {
    next(error);
  }
});

export default router;
