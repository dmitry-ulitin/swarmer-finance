import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validation';
import * as categoryService from '../services/categories';

const router = Router();

router.use(authMiddleware);

const createCategorySchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.number().int().positive(),
  color: z.string().optional(),
  icon: z.string().optional(),
});

const updateCategorySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
});

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const categories = await categoryService.getCategoryTree(req.userId!);
    res.json({ data: categories, error: null });
  } catch (error) {
    next(error);
  }
});

router.post('/', validate(createCategorySchema), async (req: AuthRequest, res, next) => {
  try {
    const { name, parentId, color, icon } = req.body;
    const category = await categoryService.createCategory(req.userId!, name, parentId, color, icon);
    res.json({ data: category, error: null });
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'statusCode' in error) {
      const err = error as { statusCode: number; message: string };
      return res.status(err.statusCode).json({ data: null, error: err.message });
    }
    next(error);
  }
});

router.put('/:id', validate(updateCategorySchema), async (req: AuthRequest, res, next) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const { name, color, icon } = req.body;
    const category = await categoryService.updateCategory(id, req.userId!, name, color, icon);
    res.json({ data: category, error: null });
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
    await categoryService.deleteCategory(id, req.userId!);
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
