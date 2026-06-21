import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types';

export interface AuthRequest extends Request {
  userId?: number;
}

export const authMiddleware = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ data: null, error: 'No token provided' });
  }
  
  const token = authHeader.split(' ')[1];
  
  try {
    // Pin the verification algorithm explicitly. Without this, jsonwebtoken
    // trusts whatever `alg` the token header advertises, which leaves the door
    // open to algorithm-confusion attacks (e.g. an attacker signing a token
    // with HS512, RS256, or "none" against the same key/secret). HS256 is
    // the algorithm used by services/auth.ts when issuing tokens.
    const decoded = jwt.verify(token, process.env.JWT_SECRET!, {
      algorithms: ['HS256'],
    }) as JwtPayload;
    if (decoded.type !== 'access') {
      return res.status(401).json({ data: null, error: 'Invalid token type' });
    }
    req.userId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ data: null, error: 'Invalid token' });
  }
};
