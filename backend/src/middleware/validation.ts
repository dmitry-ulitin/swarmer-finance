import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema, ZodError } from 'zod';
import { isIsoDate } from '../services/date';

/** A date field: YYYY-MM-DD and a real calendar day, so Postgres never sees a bad one. */
export const isoDateSchema = z.string().refine(isIsoDate, 'Expected a date as YYYY-MM-DD');

export const validate = (schema: ZodSchema, source: 'body' | 'query' = 'body') => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse(source === 'query' ? req.query : req.body);
      if (source === 'body') {
        req.body = parsed;
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const messages = error.issues.map(e => `${e.path.join('.')}: ${e.message}`);
        return res.status(400).json({ data: null, error: messages.join(', ') });
      }
      next(error);
    }
  };
};

const MAX_INT = 2_147_483_647;

/**
 * `router.param` handler for numeric route ids: anything but a positive
 * integer that fits Postgres' INTEGER is a 400, not a database error.
 */
export const validateIdParam = (req: Request, res: Response, next: NextFunction, value: string) => {
  if (/^\d{1,10}$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_INT) return next();
  res.status(400).json({ data: null, error: 'Invalid id' });
};
