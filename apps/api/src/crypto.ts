import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(pw, Buffer.from(saltB64, 'base64'), 32, { ...SCRYPT, N: Number(n) });
  const expected = Buffer.from(keyB64, 'base64');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** AES-256-GCM for secrets at rest (Kite secret and token). Key is derived from APP_SECRET. */
export function makeCipher(appSecret: string) {
  if (!appSecret || appSecret.length < 32) throw new Error('APP_SECRET must be at least 32 characters');
  const key = crypto.createHash('sha256').update(`paisa-os:${appSecret}`).digest();
  return {
    encrypt(plain: string): string {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
    },
    decrypt(enc: string): string {
      const [iv, tag, body] = enc.split('.').map((s) => Buffer.from(s, 'base64'));
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(body), d.final()]).toString('utf8');
    },
  };
}
export type Cipher = ReturnType<typeof makeCipher>;
