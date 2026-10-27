import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

// Read on every call so the key can be toggled (tests) and a missing or bad
// one only disables bank sync instead of crashing the server.
function getKey(): Buffer | null {
  const raw = process.env.BANK_CREDENTIALS_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

export function isBankSyncEnabled(): boolean {
  return getKey() !== null;
}

export function requireBankSync(): void {
  if (!isBankSyncEnabled()) {
    throw { statusCode: 503, message: 'Bank sync is not configured' };
  }
}

/** `v1.<iv>.<tag>.<ciphertext>`, base64 parts; bound to the user by the AAD. */
export function encryptSecret(plain: string, userId: number): string {
  requireBankSync();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey()!, iv);
  cipher.setAAD(Buffer.from(`user:${userId}`));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ciphertext]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64')))
    .join('.');
}

export function decryptSecret(stored: string, userId: number): string {
  try {
    const [version, iv, tag, ciphertext] = stored.split('.');
    const key = getKey();
    if (version !== 'v1' || !key || !iv || !tag || !ciphertext) throw new Error('bad format');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(`user:${userId}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw { statusCode: 500, message: 'Stored bank key cannot be decrypted' };
  }
}
