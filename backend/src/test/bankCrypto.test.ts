import crypto from 'crypto';
import {
  isBankSyncEnabled,
  requireBankSync,
  encryptSecret,
  decryptSecret,
} from '../services/bank/crypto';

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----\n';

describe('bank key encryption', () => {
  const saved = process.env.BANK_CREDENTIALS_KEY;

  beforeEach(() => {
    process.env.BANK_CREDENTIALS_KEY = crypto.randomBytes(32).toString('base64');
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.BANK_CREDENTIALS_KEY;
    else process.env.BANK_CREDENTIALS_KEY = saved;
  });

  it('round-trips a PEM', () => {
    const stored = encryptSecret(PEM, 7);
    expect(stored.startsWith('v1.')).toBe(true);
    expect(stored).not.toContain('BEGIN');
    expect(decryptSecret(stored, 7)).toBe(PEM);
  });

  it('uses a fresh IV', () => {
    expect(encryptSecret(PEM, 7)).not.toBe(encryptSecret(PEM, 7));
  });

  it("refuses another user's ciphertext", () => {
    const stored = encryptSecret(PEM, 7);
    expect(() => decryptSecret(stored, 8)).toThrow(
      expect.objectContaining({ statusCode: 500 }),
    );
  });

  it('refuses a tampered ciphertext', () => {
    const parts = encryptSecret(PEM, 7).split('.');
    const ct = parts[3];
    parts[3] = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    expect(() => decryptSecret(parts.join('.'), 7)).toThrow(
      expect.objectContaining({ statusCode: 500 }),
    );
  });

  it('is disabled without a key or with a short one', () => {
    delete process.env.BANK_CREDENTIALS_KEY;
    expect(isBankSyncEnabled()).toBe(false);
    expect(() => requireBankSync()).toThrow(
      expect.objectContaining({ statusCode: 503, message: 'Bank sync is not configured' }),
    );
    process.env.BANK_CREDENTIALS_KEY = crypto.randomBytes(16).toString('base64');
    expect(isBankSyncEnabled()).toBe(false);
  });
});
