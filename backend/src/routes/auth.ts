import { Router } from 'express';
import { z } from 'zod';
import * as authService from '../services/auth';
import { validate } from '../middleware/validation';

const router = Router();

// Currency code: 3 uppercase ASCII letters (ISO 4217, e.g. USD, EUR, GBP)
// or 4 uppercase ASCII letters (crypto-style tickers like USDT, USDC).
// Mirrors routes/accounts.ts's currencySchema.
const currencySchema = z
  .string()
  .regex(/^[A-Z]{3,4}$/, 'Currency must be 3 or 4 uppercase ASCII letters (e.g. USD, EUR, USDT)');

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().optional(),
  currency: currencySchema.optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const refreshSchema = z.object({
  refreshToken: z.string(),
});

router.post('/register', validate(registerSchema), async (req, res, next) => {
  try {
    const { email, password, name, currency } = req.body;
    const result = await authService.register(email, password, name, currency);
    res.json({
      data: {
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          currency: result.user.currency,
          currency_scale: result.user.currency_scale,
        },
        ...result.tokens,
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/login', validate(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const result = await authService.login(email, password);
    res.json({
      data: {
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          currency: result.user.currency,
          currency_scale: result.user.currency_scale,
        },
        ...result.tokens,
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/refresh', validate(refreshSchema), async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    const tokens = await authService.refreshTokens(refreshToken);
    res.json({ data: tokens, error: null });
  } catch (error) {
    next(error);
  }
});

export default router;
