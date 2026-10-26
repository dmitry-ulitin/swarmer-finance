import { Router } from 'express';
import { z } from 'zod';
import * as authService from '../services/auth';
import * as loginLimiter from '../services/loginLimiter';
import { validate } from '../middleware/validation';

const router = Router();

// Currency code: 3 uppercase ASCII letters (ISO 4217, e.g. USD, EUR, GBP)
// or 4 uppercase ASCII letters (crypto-style tickers like USDT, USDC).
// Mirrors routes/accounts.ts's currencySchema.
const currencySchema = z
  .string()
  .regex(/^[A-Z]{3,4}$/, 'Currency must be 3 or 4 uppercase ASCII letters (e.g. USD, EUR, USDT)');

// Emails are stored and looked up lowercase, so Bob@x and bob@x are one
// user (migration 017 enforces it).
const emailSchema = z.string().trim().toLowerCase().email();

const registerSchema = z.object({
  email: emailSchema,
  password: z.string().min(6),
  name: z.string().optional(),
  currency: currencySchema.optional(),
});

const loginSchema = z.object({
  email: emailSchema,
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
    const key = `${req.ip}|${email}`;
    if (loginLimiter.isBlocked(key)) {
      return next({ statusCode: 429, message: 'Too many failed login attempts, try again later' });
    }
    let result;
    try {
      result = await authService.login(email, password);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 401) {
        loginLimiter.recordFailure(key);
        console.warn(`Failed login for ${email} from ${req.ip}`);
      }
      throw error;
    }
    loginLimiter.clearFailures(key);
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
