import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp } from './testApp';

/**
 * Regression tests for the JWT algorithm allowlist fix.
 *
 * Background: jwt.verify() without an explicit `algorithms` option trusts
 * whatever `alg` is advertised in the token header. This makes the verifier
 * vulnerable to algorithm-confusion attacks (HS512, RS256, "none", etc.).
 *
 * After the fix, both the access-token middleware and the refresh-token
 * service pin the verifier to `['HS256']`, which is the algorithm used by
 * services/auth.ts when issuing tokens.
 *
 * These tests forge tokens with non-HS256 algorithms using the same secret
 * the server trusts, then assert the server rejects them.
 */
describe('JWT algorithm allowlist', () => {
  const app = createTestApp();
  const accessSecret = process.env.JWT_SECRET!;
  const refreshSecret = process.env.JWT_REFRESH_SECRET!;

  function forgeToken(
    secret: string,
    payload: object,
    algorithm: jwt.Algorithm | 'none',
  ): string {
    if (algorithm === 'none') {
      // jsonwebtoken refuses to sign with alg:none, so hand-roll a token.
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
        .toString('base64url');
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${header}.${body}.`;
    }
    return jwt.sign(payload, secret, { algorithm });
  }

  describe('access token (auth middleware)', () => {
    it('accepts a valid HS256 access token (sanity check)', async () => {
      const token = jwt.sign(
        { userId: 1, type: 'access' },
        accessSecret,
        { algorithm: 'HS256', expiresIn: '15m' },
      );
      const res = await request(app)
        .get('/api/categories')
        .set('Authorization', `Bearer ${token}`);
      // 200 (empty tree) or any non-401 response — point is we passed auth.
      expect(res.status).not.toBe(401);
    });

    it('rejects a token signed with HS512 using the same secret', async () => {
      const token = forgeToken(
        accessSecret,
        { userId: 1, type: 'access' },
        'HS512',
      );
      const res = await request(app)
        .get('/api/categories')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid token');
    });

    it('rejects a token with alg=none', async () => {
      const token = forgeToken(
        accessSecret,
        { userId: 1, type: 'access' },
        'none',
      );
      const res = await request(app)
        .get('/api/categories')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid token');
    });
  });

  describe('refresh token (auth service)', () => {
    it('rejects a refresh token signed with HS512 using the same secret', async () => {
      const token = forgeToken(
        refreshSecret,
        { userId: 1, type: 'refresh' },
        'HS512',
      );
      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: token });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid refresh token');
    });

    it('rejects a refresh token with alg=none', async () => {
      const token = forgeToken(
        refreshSecret,
        { userId: 1, type: 'refresh' },
        'none',
      );
      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: token });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid refresh token');
    });
  });
});