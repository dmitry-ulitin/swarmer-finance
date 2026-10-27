import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validation';
import * as profileService from '../services/profile';

const router = Router();

router.use(authMiddleware);

// Mirrors routes/auth.ts's currencySchema.
const currencySchema = z
  .string()
  .regex(/^[A-Z]{3,4}$/, 'Currency must be 3 or 4 uppercase ASCII letters (e.g. USD, EUR, USDT)');

const updateProfileSchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  currency: currencySchema,
});

router.put('/', validate(updateProfileSchema), async (req: AuthRequest, res, next) => {
  try {
    const user = await profileService.updateProfile(req.userId!, req.body);
    res.json({ data: user, error: null });
  } catch (error) {
    next(error);
  }
});

export default router;
