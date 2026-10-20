import { Request, Response, NextFunction } from 'express';

export interface AppError extends Error {
  statusCode?: number;
}

export const errorHandler = (
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  console.error('Error:', err.message);
  
  const statusCode = err.statusCode || 500;
  // Only errors thrown on purpose carry a statusCode; anything else (a
  // database error, a bug) is logged above and not described to the client.
  const message = err.statusCode ? err.message : 'Internal server error';
  
  res.status(statusCode).json({
    data: null,
    error: message,
  });
};
