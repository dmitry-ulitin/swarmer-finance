import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import categoryRoutes from './routes/categories';
import transactionRoutes from './routes/transactions';
import accountRoutes from './routes/accounts';
import importRoutes from './routes/import';
import profileRoutes from './routes/profile';
import bankRoutes from './routes/bank';
import { errorHandler } from './middleware/error';

dotenv.config();

const app = express();

// Render terminates TLS in front of the app; take the client IP (used by the
// login throttle) from the X-Forwarded-For entry its proxy appends.
app.set('trust proxy', 1);

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/import', importRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/bank', bankRoutes);

app.use(errorHandler);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
