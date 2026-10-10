import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEY_LEN = 32;

/** Хеш пароля: scrypt с уникальной солью. Формат: scrypt$<salt hex>$<hash hex>. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------- JWT (HS256) без внешних зависимостей ----------

export interface TokenClaims {
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');
const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

export function signToken(sub: string, secret: string, nowMs: number, ttlSec = 7 * 24 * 3600): string {
  const iat = Math.floor(nowMs / 1000);
  const payload = b64url(JSON.stringify({ sub, iat, exp: iat + ttlSec }));
  const sig = createHmac('sha256', secret).update(`${HEADER}.${payload}`).digest('base64url');
  return `${HEADER}.${payload}.${sig}`;
}

/** Проверка подписи (в постоянное время), алгоритма и срока действия. Невалидный токен → null. */
export function verifyToken(token: string, secret: string, nowMs: number): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  if (header !== HEADER) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url'));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<TokenClaims>;
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number' || typeof claims.iat !== 'number') return null;
    if (claims.exp * 1000 <= nowMs) return null;
    return claims as TokenClaims;
  } catch {
    return null;
  }
}
