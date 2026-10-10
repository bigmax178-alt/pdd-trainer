/**
 * Учётные записи без сервера: подписанные удостоверения (ECDSA P-256 через WebCrypto).
 *
 *   корневой ключ автошколы (у администратора)
 *     ├─ удостоверение управляющего (содержит его открытый ключ) ── удостоверения учеников этого управляющего
 *     └─ удостоверения учеников, выданные администратором
 *
 * Сайт знает только открытый корневой ключ (school.json) и проверяет цепочку подписей.
 * Выдать или подделать доступ без закрытого ключа невозможно; база данных и сервер не нужны.
 */

export type Role = 'admin' | 'manager' | 'student';

export const ROLE_TITLE: Readonly<Record<Role, string>> = {
  admin: 'Администратор',
  manager: 'Управляющий',
  student: 'Ученик',
};

/** Подписанное утверждение о пользователе. Время — в секундах Unix. */
export interface Claim {
  readonly v: 1;
  readonly id: string;
  readonly role: 'manager' | 'student';
  readonly name: string;
  /** Кто выдал: 'root' (администратор) или id управляющего. */
  readonly iss: string;
  readonly iat: number;
  /** Окончание доступа; 0 — бессрочно. */
  readonly exp: number;
  /** Открытый ключ управляющего (raw, base64url) — только у роли manager. */
  readonly pub?: string;
}

export interface SchoolConfig {
  readonly name: string;
  readonly rootKey: string;
  /** Заблокированные id удостоверений; блокировка управляющего блокирует и выданных им учеников. */
  readonly revoked: readonly string[];
}

export interface Identity {
  readonly role: Role;
  readonly id: string;
  readonly name: string;
  readonly exp: number;
  /** Удостоверения от корня к пользователю; у администратора — пусто. */
  readonly chain: readonly string[];
}

export class CredentialError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CredentialError';
    this.code = code;
  }
}

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;
const NAME_MAX = 80;
const enc = new TextEncoder();
const dec = new TextDecoder();

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new CredentialError('no_crypto', 'Браузер не поддерживает защищённый вход — обновите браузер или откройте сайт по https');
  return s;
}

// ---------- base64url ----------

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new CredentialError('bad_encoding', 'Приглашение повреждено');
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    throw new CredentialError('bad_encoding', 'Приглашение повреждено');
  }
}

export function randomToken(bytes = 9): string {
  return b64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

// ---------- Ключи ----------

export interface KeyPairStrings {
  /** Открытый ключ: несжатая точка P-256 (65 байт), base64url. */
  readonly publicKey: string;
  /** Закрытый ключ: скаляр d (32 байта), base64url. */
  readonly privateKey: string;
}

export async function generateKeyPair(): Promise<KeyPairStrings> {
  const kp = await subtle().generateKey(ALG, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
  const jwk = await subtle().exportKey('jwk', kp.privateKey);
  if (!jwk.d) throw new CredentialError('keygen', 'Не удалось создать ключ');
  return { publicKey: b64urlEncode(raw), privateKey: jwk.d };
}

export async function importPublicKey(pub: string): Promise<CryptoKey> {
  const raw = b64urlDecode(pub);
  if (raw.length !== 65 || raw[0] !== 4) throw new CredentialError('bad_key', 'Некорректный открытый ключ');
  return subtle().importKey('raw', raw, ALG, false, ['verify']);
}

export async function importPrivateKey(d: string, pub: string): Promise<CryptoKey> {
  const raw = b64urlDecode(pub);
  if (raw.length !== 65 || raw[0] !== 4 || b64urlDecode(d).length !== 32) throw new CredentialError('bad_key', 'Некорректный ключ доступа');
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', d, x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33)), ext: true };
  try {
    return await subtle().importKey('jwk', jwk, ALG, false, ['sign']);
  } catch {
    throw new CredentialError('bad_key', 'Некорректный ключ доступа');
  }
}

/** Закрытый ключ действительно парный открытому: подписываем случайные данные и проверяем. */
export async function keyMatches(privateKey: CryptoKey, pub: string): Promise<boolean> {
  const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const sig = await subtle().sign(SIGN, privateKey, challenge);
  return subtle().verify(SIGN, await importPublicKey(pub), sig, challenge);
}

// ---------- Удостоверения ----------

export async function signClaim(claim: Claim, key: CryptoKey): Promise<string> {
  const body = enc.encode(JSON.stringify(claim));
  const sig = new Uint8Array(await subtle().sign(SIGN, key, body));
  return `${b64urlEncode(body)}.${b64urlEncode(sig)}`;
}

function parseClaim(raw: unknown): Claim {
  const c = raw as Partial<Claim>;
  const ok = c && c.v === 1 && typeof c.id === 'string' && /^[\w-]{4,64}$/.test(c.id)
    && (c.role === 'manager' || c.role === 'student') && typeof c.name === 'string' && c.name.length > 0 && c.name.length <= NAME_MAX
    && typeof c.iss === 'string' && Number.isInteger(c.iat) && Number.isInteger(c.exp) && (c.exp ?? -1) >= 0
    && (c.role === 'manager' ? typeof c.pub === 'string' : c.pub === undefined);
  if (!ok) throw new CredentialError('bad_claim', 'Приглашение повреждено');
  return c as Claim;
}

/** Проверка подписи токена «тело.подпись» и разбор утверждения. */
export async function readToken(token: string, pub: CryptoKey): Promise<Claim> {
  const parts = token.split('.');
  if (parts.length !== 2) throw new CredentialError('bad_token', 'Приглашение повреждено');
  const body = b64urlDecode(parts[0] as string);
  const sig = b64urlDecode(parts[1] as string);
  if (!(await subtle().verify(SIGN, pub, sig, body))) {
    throw new CredentialError('bad_signature', 'Приглашение не выдано автошколой или изменено');
  }
  let json: unknown;
  try {
    json = JSON.parse(dec.decode(body));
  } catch {
    throw new CredentialError('bad_claim', 'Приглашение повреждено');
  }
  return parseClaim(json);
}

function checkActive(claim: Claim, school: SchoolConfig, nowSec: number): void {
  if (school.revoked.includes(claim.id)) throw new CredentialError('revoked', 'Доступ заблокирован автошколой');
  if (claim.exp !== 0 && claim.exp <= nowSec) throw new CredentialError('expired', 'Срок доступа истёк — обратитесь в автошколу');
}

const minExp = (a: number, b: number) => (a === 0 ? b : b === 0 ? a : Math.min(a, b));

/**
 * Проверка цепочки: [удостоверение от корня] или [управляющий от корня, ученик от управляющего].
 * Управляющий не может выдавать управляющих; блокировка или окончание срока звена закрывает всю цепочку.
 */
export async function verifyChain(chain: readonly string[], school: SchoolConfig, nowSec: number): Promise<Identity> {
  if (chain.length < 1 || chain.length > 2) throw new CredentialError('bad_chain', 'Приглашение повреждено');
  const first = await readToken(chain[0] as string, await importPublicKey(school.rootKey));
  if (first.iss !== 'root') throw new CredentialError('bad_chain', 'Приглашение повреждено');
  checkActive(first, school, nowSec);
  if (chain.length === 1) return { role: first.role, id: first.id, name: first.name, exp: first.exp, chain: [...chain] };

  if (first.role !== 'manager' || !first.pub) throw new CredentialError('bad_chain', 'Приглашение повреждено');
  const second = await readToken(chain[1] as string, await importPublicKey(first.pub));
  if (second.iss !== first.id || second.role !== 'student') {
    throw new CredentialError('forbidden', 'Управляющий может выдавать доступ только ученикам');
  }
  checkActive(second, school, nowSec);
  return { role: 'student', id: second.id, name: second.name, exp: minExp(first.exp, second.exp), chain: [...chain] };
}

// ---------- Выдача доступа ----------

/** Разблокированный сотрудник: удостоверение + закрытый ключ для подписи. */
export interface StaffKey {
  readonly identity: Identity;
  readonly key: CryptoKey;
}

export interface IssueInput {
  readonly role: 'manager' | 'student';
  readonly name: string;
  /** Срок доступа в месяцах (30 дней); 0 — бессрочно. */
  readonly months: number;
}

/** Окончание доступа через N календарных месяцев (0 — бессрочно). */
export function addMonths(nowSec: number, months: number): number {
  if (!months) return 0;
  const d = new Date(nowSec * 1000);
  d.setMonth(d.getMonth() + months);
  return Math.floor(d.getTime() / 1000);
}

export interface Issued {
  readonly claim: Claim;
  readonly chain: readonly string[];
  /** Код приглашения (часть ссылки после #invite=). */
  readonly invite: string;
}

export function normalizeName(name: string): string {
  return name.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim();
}

export async function issueAccount(staff: StaffKey, input: IssueInput, nowSec: number, newId: () => string = randomToken): Promise<Issued> {
  const { role } = staff.identity;
  if (role === 'student') throw new CredentialError('forbidden', 'Ученик не может создавать учётные записи');
  if (role === 'manager' && input.role !== 'student') throw new CredentialError('forbidden', 'Управляющий может создавать только учеников');
  const name = normalizeName(input.name);
  if (name.length < 2 || name.length > NAME_MAX) throw new CredentialError('bad_name', `Укажите имя: от 2 до ${NAME_MAX} символов`);
  if (!Number.isInteger(input.months) || input.months < 0 || input.months > 120) throw new CredentialError('bad_term', 'Некорректный срок доступа');

  // Доступ не может пережить доступ того, кто его выдал.
  const exp = minExp(addMonths(nowSec, input.months), staff.identity.exp);
  const keys = input.role === 'manager' ? await generateKeyPair() : undefined;
  const claim: Claim = {
    v: 1,
    id: newId(),
    role: input.role,
    name,
    iss: role === 'admin' ? 'root' : staff.identity.id,
    iat: nowSec,
    exp,
    ...(keys ? { pub: keys.publicKey } : {}),
  };
  const token = await signClaim(claim, staff.key);
  const chain = role === 'admin' ? [token] : [...staff.identity.chain, token];
  return { claim, chain, invite: encodeInvite(chain, keys?.privateKey) };
}

// ---------- Приглашения ----------

export interface Invite {
  /** Пустая цепочка — приглашение администратора (только закрытый корневой ключ). */
  readonly chain: readonly string[];
  readonly key?: string;
}

/** Формат: «токен~токен!ключ» или «root!ключ» для администратора. Ключ есть только у сотрудников. */
export function encodeInvite(chain: readonly string[], key?: string): string {
  const head = chain.length ? chain.join('~') : 'root';
  return key ? `${head}!${key}` : head;
}

export function decodeInvite(text: string): Invite {
  const code = text.trim().replace(/^.*#invite=/, '');
  const [head = '', key, extra] = code.split('!');
  if (extra !== undefined || !head) throw new CredentialError('bad_invite', 'Это не приглашение автошколы');
  if (key !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new CredentialError('bad_invite', 'Приглашение повреждено');
  if (head === 'root') {
    if (!key) throw new CredentialError('bad_invite', 'Приглашение повреждено');
    return { chain: [], key };
  }
  const chain = head.split('~');
  if (chain.some((t) => !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t))) throw new CredentialError('bad_invite', 'Это не приглашение автошколы');
  return key ? { chain, key } : { chain };
}

/** Сотрудник по приглашению: проверяем цепочку (или корень) и что ключ парный. */
export async function staffFromInvite(invite: Invite, school: SchoolConfig, nowSec: number): Promise<StaffKey> {
  if (!invite.key) throw new CredentialError('not_staff', 'Это приглашение ученика');
  if (invite.chain.length === 0) {
    const key = await importPrivateKey(invite.key, school.rootKey);
    if (!(await keyMatches(key, school.rootKey))) throw new CredentialError('bad_key', 'Ключ не принадлежит этой автошколе');
    return { identity: { role: 'admin', id: 'root', name: 'Администратор', exp: 0, chain: [] }, key };
  }
  const identity = await verifyChain(invite.chain, school, nowSec);
  const pub = (await readToken(invite.chain[0] as string, await importPublicKey(school.rootKey))).pub;
  if (identity.role !== 'manager' || !pub) throw new CredentialError('not_staff', 'Это приглашение ученика');
  const key = await importPrivateKey(invite.key, pub);
  if (!(await keyMatches(key, pub))) throw new CredentialError('bad_key', 'Ключ не подходит к приглашению');
  return { identity, key };
}

// ---------- Защита ключа паролем на устройстве ----------

export interface SealedSecret {
  readonly v: 1;
  readonly iter: number;
  readonly salt: string;
  readonly iv: string;
  readonly ct: string;
}

export const PBKDF2_ITERATIONS = 600_000;

async function passwordKey(password: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealSecret(secret: string, password: string, iter = PBKDF2_ITERATIONS): Promise<SealedSecret> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, await passwordKey(password, salt, iter), enc.encode(secret)));
  return { v: 1, iter, salt: b64urlEncode(salt), iv: b64urlEncode(iv), ct: b64urlEncode(ct) };
}

export async function openSecret(sealed: SealedSecret, password: string): Promise<string> {
  try {
    const key = await passwordKey(password, b64urlDecode(sealed.salt), sealed.iter);
    return dec.decode(await subtle().decrypt({ name: 'AES-GCM', iv: b64urlDecode(sealed.iv) }, key, b64urlDecode(sealed.ct)));
  } catch {
    throw new CredentialError('bad_password', 'Неверный пароль');
  }
}

/** Разбор school.json: имя автошколы, открытый корневой ключ, список заблокированных. */
export function parseSchoolConfig(raw: unknown): SchoolConfig {
  const r = raw as Partial<SchoolConfig> | null;
  if (!r || typeof r.name !== 'string' || typeof r.rootKey !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(r.rootKey)) {
    throw new CredentialError('bad_school', 'Файл настроек автошколы повреждён');
  }
  const revoked = Array.isArray(r.revoked) ? r.revoked.filter((x): x is string => typeof x === 'string') : [];
  return { name: r.name, rootKey: r.rootKey, revoked };
}
