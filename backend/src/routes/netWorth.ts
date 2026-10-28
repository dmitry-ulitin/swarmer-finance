import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import * as netWorthService from '../services/netWorth';

const router = Router();

router.use(authMiddleware);

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    res.json({ data: await netWorthService.getNetWorth(req.userId!), error: null });
  } catch (error) {
    next(error);
  }
});

export default router;
