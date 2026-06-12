import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

export const validate = (schema: ZodSchema, source: 'body' | 'query' = 'body') => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse(source === 'query' ? req.query : req.body);
      if (source === 'query') {
        req.query = parsed;
      } else {
        req.body = parsed;
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const messages = error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
        return res.status(400).json({ data: null, error: messages.join(', ') });
      }
      next(error);
    }
  };
};
