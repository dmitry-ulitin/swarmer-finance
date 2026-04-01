import express from 'express';
import cors from 'cors';
import authRoutes from '../routes/auth';
import categoryRoutes from '../routes/categories';
import transactionRoutes from '../routes/transactions';
import { errorHandler } from '../middleware/error';

export function createTestApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/categories', categoryRoutes);
  app.use('/api/transactions', transactionRoutes);
  app.use(errorHandler);
  return app;
}
