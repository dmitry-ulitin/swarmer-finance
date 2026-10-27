import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate, validateIdParam } from '../middleware/validation';
import { requireBankSync } from '../services/bank/crypto';
import * as connections from '../services/bank/connections';

const router = Router();

router.use(authMiddleware);
router.param('id', validateIdParam);

const countrySchema = z.string().regex(/^[A-Z]{2}$/, 'Country must be 2 uppercase letters');

// The consent redirect must come back to the app's own callback page.
const redirectUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname === '/bank-callback';
  } catch {
    return false;
  }
}, 'Redirect URL must be an https:// address ending in /bank-callback');

const credentialsSchema = z.object({
  applicationId: z.string().uuid(),
  privateKey: z.string().min(1).max(20_000),
});

const aspspsQuerySchema = z.object({ country: countrySchema });

const startSchema = z.object({
  aspspName: z.string().min(1).max(200),
  country: countrySchema,
  redirectUrl: redirectUrlSchema,
});

const reconnectSchema = z.object({ redirectUrl: redirectUrlSchema });

const completeSchema = z.object({
  state: z.string().min(1).max(200),
  code: z.string().min(1).max(2000),
});

router.get('/credentials', async (req: AuthRequest, res, next) => {
  try {
    res.json({ data: await connections.getCredentialsInfo(req.userId!), error: null });
  } catch (error) {
    next(error);
  }
});

// Everything below needs BANK_CREDENTIALS_KEY.
router.use((_req, _res, next) => {
  try {
    requireBankSync();
    next();
  } catch (error) {
    next(error);
  }
});

router.put('/credentials', validate(credentialsSchema), async (req: AuthRequest, res, next) => {
  try {
    const { applicationId, privateKey } = req.body;
    const data = await connections.saveCredentials(req.userId!, applicationId, privateKey);
    res.json({ data, error: null });
  } catch (error) {
    next(error);
  }
});

router.delete('/credentials', async (req: AuthRequest, res, next) => {
  try {
    await connections.deleteCredentials(req.userId!);
    res.json({ data: { success: true }, error: null });
  } catch (error) {
    next(error);
  }
});

router.get('/aspsps', validate(aspspsQuerySchema, 'query'), async (req: AuthRequest, res, next) => {
  try {
    const data = await connections.listAspsps(req.userId!, String(req.query.country));
    res.json({ data, error: null });
  } catch (error) {
    next(error);
  }
});

router.get('/connections', async (req: AuthRequest, res, next) => {
  try {
    res.json({ data: await connections.listConnections(req.userId!), error: null });
  } catch (error) {
    next(error);
  }
});

router.post('/connections', validate(startSchema), async (req: AuthRequest, res, next) => {
  try {
    const { aspspName, country, redirectUrl } = req.body;
    const data = await connections.startConnection(req.userId!, aspspName, country, redirectUrl);
    res.json({ data, error: null });
  } catch (error) {
    next(error);
  }
});

router.post('/connections/complete', validate(completeSchema), async (req: AuthRequest, res, next) => {
  try {
    const { state, code } = req.body;
    const data = await connections.completeConnection(req.userId!, state, code);
    res.json({ data, error: null });
  } catch (error) {
    next(error);
  }
});

router.post('/connections/:id/reconnect', validate(reconnectSchema), async (req: AuthRequest, res, next) => {
  try {
    const data = await connections.reconnect(req.userId!, Number(req.params.id), req.body.redirectUrl);
    res.json({ data, error: null });
  } catch (error) {
    next(error);
  }
});

router.delete('/connections/:id', async (req: AuthRequest, res, next) => {
  try {
    await connections.deleteConnection(req.userId!, Number(req.params.id));
    res.json({ data: { success: true }, error: null });
  } catch (error) {
    next(error);
  }
});

export default router;
