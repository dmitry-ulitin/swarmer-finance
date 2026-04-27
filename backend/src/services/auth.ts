import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import * as userQueries from '../db/queries/users';
import * as categoryQueries from '../db/queries/categories';
import { User, AuthTokens, JwtPayload } from '../types';

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';

const generateTokens = (userId: number): AuthTokens => {
  const accessToken = jwt.sign(
    { userId, type: 'access' } as JwtPayload,
    process.env.JWT_SECRET!,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
  
  const refreshToken = jwt.sign(
    { userId, type: 'refresh' } as JwtPayload,
    process.env.JWT_REFRESH_SECRET!,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
  
  return { accessToken, refreshToken };
};

export const register = async (email: string, password: string, name: string, currency: string): Promise<{ user: User; tokens: AuthTokens }> => {
  const existingUser = await userQueries.getUserByEmail(email);
  if (existingUser) {
    throw { statusCode: 400, message: 'Email already registered' };
  }
  
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await userQueries.createUser(email, passwordHash, name || email.split('@')[0], currency || 'EUR');
  
  // Seed default categories for new user
  await seedDefaultCategories(user.id);
  
  const tokens = generateTokens(user.id);
  
  return { user, tokens };
};

export const login = async (email: string, password: string): Promise<{ user: User; tokens: AuthTokens }> => {
  const user = await userQueries.getUserByEmail(email);
  if (!user) {
    throw { statusCode: 401, message: 'Invalid credentials' };
  }
  
  const isValidPassword = await bcrypt.compare(password, user.password_hash);
  if (!isValidPassword) {
    throw { statusCode: 401, message: 'Invalid credentials' };
  }
  
  const tokens = generateTokens(user.id);
  
  return { user, tokens };
};

export const refreshTokens = async (refreshToken: string): Promise<AuthTokens> => {
  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!) as JwtPayload;
    if (decoded.type !== 'refresh') {
      throw { statusCode: 401, message: 'Invalid token type' };
    }

    const user = await userQueries.getUserById(decoded.userId);
    if (!user) {
      throw { statusCode: 401, message: 'User not found' };
    }

    return { ...generateTokens(user.id), user: { id: user.id, email: user.email, name: user.name, currency: user.currency } };
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error;
    throw { statusCode: 401, message: 'Invalid refresh token' };
  }
};

const seedDefaultCategories = async (userId: number): Promise<void> => {
  // Income subcategories
  const incomeCategories = ['Salary', 'Freelance', 'Investments'];
  for (const name of incomeCategories) {
    await categoryQueries.createCategory(userId, name, 1, '#22c55e', 'briefcase');
  }
  
  // Expense subcategories
  const expenseCategories = [
    { name: 'Food', color: '#f97316', icon: 'utensils' },
    { name: 'Transport', color: '#3b82f6', icon: 'car' },
    { name: 'Housing', color: '#8b5cf6', icon: 'home' },
    { name: 'Healthcare', color: '#ef4444', icon: 'heart-pulse' },
    { name: 'Entertainment', color: '#ec4899', icon: 'gamepad-2' },
  ];
  
  for (const cat of expenseCategories) {
    await categoryQueries.createCategory(userId, cat.name, 2, cat.color, cat.icon);
  }
};
