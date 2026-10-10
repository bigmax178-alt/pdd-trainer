import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Clock, randomId, systemClock } from '../app/ports.ts';
import { type ExamState, answerExam, createExam, GIBDD_EXAM_RULES, tickExam } from '../core/exam.ts';
import {
  type Progress, ProgressFormatError, emptyProgress, examRecord, mergeProgress, parseProgress, recordAnswer, recordExam,
} from '../core/progress.ts';
import { QuestionBank } from '../core/question-bank.ts';
import { randomSeed } from '../core/rng.ts';
import { type BankId, type ContentPack, DomainError } from '../core/types.ts';
import { CATEGORIES, TICKET_SETS, UNCONFIRMED_CATEGORIES, categoryInfo, findTicketSet, isCategoryCode } from '../content/categories.ts';
import { hashPassword, signToken, verifyPassword, verifyToken } from './auth.ts';
import type { ProgressRecord, Repository } from './repository.ts';

export const API_VERSION = '1.0.0';

export interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly msg: string;
  readonly [key: string]: unknown;
}

export interface AppConfig {
  readonly repo: Repository;
  readonly secret: string;
  readonly pack: ContentPack;
  readonly clock?: Clock;
  readonly log?: (entry: LogEntry) => void;
  /** Разрешённые источники CORS; ['*'] — любой (API использует Bearer-токены, cookies нет). */
  readonly corsOrigins?: readonly string[];
  readonly rateLimit?: { readonly windowMs: number; readonly max: number; readonly authMax: number };
  readonly newId?: () => string;
  readonly seed?: () => number;
  readonly maxBodyBytes?: number;
}

/** Ошибка API в формате RFC 9457 (application/problem+json). */
export class HttpError extends Error {
  readonly status: number;
  readonly title: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, title: string, detail?: string, extra: Record<string, unknown> = {}) {
    super(detail ?? title);
    this.status = status;
    this.title = title;
    this.extra = extra;
  }
}

interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: Readonly<Record<string, string>>;
  readonly reqId: string;
  readonly now: number;
  readonly userId: string;
  body(): Promise<Record<string, unknown>>;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Handler = (ctx: Ctx) => Promise<Reply>;
interface Route { method: string; path: RegExp; auth: boolean; bucket: 'auth' | 'api'; handler: Handler }

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

export function createApp(cfg: AppConfig): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const clock = cfg.clock ?? systemClock;
  const log = cfg.log ?? ((e: LogEntry) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...e })));
  const newId = cfg.newId ?? randomId;
  const seed = cfg.seed ?? randomSeed;
  const origins = cfg.corsOrigins ?? ['*'];
  const limits = cfg.rateLimit ?? { windowMs: 60_000, max: 600, authMax: 20 };
  const maxBody = cfg.maxBodyBytes ?? 2_000_000;
  const banks: Record<BankId, QuestionBank> = { AB: new QuestionBank(cfg.pack, 'AB'), CD: new QuestionBank(cfg.pack, 'CD') };
  const contentEtag = `"content-${cfg.pack.version}"`;
  const hits = new Map<string, { count: number; resetAt: number }>();

  // ---------- Вспомогательные ----------

  function rateLimit(key: string, max: number, now: number): void {
    const hit = hits.get(key);
    if (!hit || hit.resetAt <= now) {
      if (hits.size > 50_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      hits.set(key, { count: 1, resetAt: now + limits.windowMs });
      return;
    }
    hit.count++;
    if (hit.count > max) {
      throw new HttpError(429, 'Слишком много запросов', 'Повторите попытку позже', { retryAfterSec: Math.ceil((hit.resetAt - now) / 1000) });
    }
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const type = req.headers['content-type'] ?? '';
    if (!type.includes('application/json')) throw new HttpError(415, 'Ожидается application/json');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBody) throw new HttpError(413, 'Слишком большой запрос');
      chunks.push(chunk);
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      return parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'Некорректный JSON');
    }
  }

  async function loadProgress(userId: string): Promise<ProgressRecord> {
    return (await cfg.repo.getProgress(userId)) ?? { progress: emptyProgress(0), revision: 0 };
  }

  /** Чтение-изменение-запись с повтором при конфликте ревизий (параллельные запросы того же пользователя). */
  async function updateProgress(userId: string, fn: (p: Progress) => Progress): Promise<ProgressRecord> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await loadProgress(userId);
      const saved = await cfg.repo.saveProgress(userId, fn(cur.progress), cur.revision);
      if (saved !== 'conflict') return saved;
    }
    throw new HttpError(503, 'Хранилище занято', 'Повторите запрос');
  }

  async function loadExam(id: string, userId: string): Promise<ExamState> {
    const row = await cfg.repo.getExam(id);
    if (!row || row.userId !== userId) throw new HttpError(404, 'Экзамен не найден');
    return row.state;
  }

  /** Представление экзамена для клиента: до завершения правильные ответы не раскрываются (анти-чит). */
  function examView(state: ExamState, now: number) {
    const bank = banks[state.bankId];
    const finished = state.verdict !== 'in_progress';
    return {
      id: state.id,
      bankId: state.bankId,
      verdict: state.verdict,
      ...(state.failReason ? { failReason: state.failReason } : {}),
      startedAt: state.startedAt,
      deadline: state.deadline,
      remainingMs: Math.max(0, state.deadline - (finished ? (state.finishedAt ?? now) : now)),
      cursor: state.cursor,
      items: state.items.map((it, index) => {
        const q = bank.get(it.questionId);
        return {
          index,
          questionId: q.id,
          block: it.block,
          extra: it.extra,
          text: q.text,
          ...(q.image ? { image: q.image } : {}),
          options: it.optionOrder.map((o) => q.options[o]),
          answered: it.answer !== undefined,
          ...(finished ? {
            chosen: it.answer === undefined ? null : it.optionOrder.indexOf(it.answer),
            correct: it.correct ?? false,
            correctOption: it.optionOrder.indexOf(q.correctIndex),
            explanation: q.explanation,
          } : {}),
        };
      }),
    };
  }

  // ---------- Маршруты ----------

  const routes: Route[] = [];
  const route = (method: string, path: string, opts: { auth?: boolean; bucket?: 'auth' | 'api' }, handler: Handler) => {
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
    routes.push({ method, path: pattern, auth: opts.auth ?? false, bucket: opts.bucket ?? 'api', handler });
  };

  route('GET', '/api/v1/health', {}, async () => ({ status: 200, body: { status: 'ok', version: API_VERSION, content: cfg.pack.version } }));

  route('GET', '/api/v1/categories', {}, async () => ({ status: 200, body: { ticketSets: TICKET_SETS, items: CATEGORIES, unconfirmed: UNCONFIRMED_CATEGORIES } }));

  route('GET', '/api/v1/content', {}, async ({ req }): Promise<Reply> => {
    if (req.headers['if-none-match'] === contentEtag) return { status: 304, headers: { etag: contentEtag } };
    return { status: 200, body: cfg.pack, headers: { etag: contentEtag, 'cache-control': 'public, max-age=3600' } };
  });

  route('POST', '/api/v1/auth/register', { bucket: 'auth' }, async ({ body, now }) => {
    const b = await body();
    const email = String(b.email ?? '').trim().toLowerCase();
    const password = String(b.password ?? '');
    const errors: Record<string, string> = {};
    if (!EMAIL_RE.test(email)) errors.email = 'Некорректный email';
    if (password.length < 8 || password.length > 128) errors.password = 'Пароль должен содержать от 8 до 128 символов';
    if (Object.keys(errors).length) throw new HttpError(422, 'Ошибка валидации', 'Проверьте поля формы', { errors });
    const user = { id: newId(), email, passwordHash: await hashPassword(password), createdAt: now };
    if (!(await cfg.repo.createUser(user))) throw new HttpError(409, 'Пользователь с таким email уже зарегистрирован');
    return { status: 201, body: { token: signToken(user.id, cfg.secret, now), user: { id: user.id, email } } };
  });

  route('POST', '/api/v1/auth/login', { bucket: 'auth' }, async ({ body, now }) => {
    const b = await body();
    const user = await cfg.repo.findUserByEmail(String(b.email ?? '').trim().toLowerCase());
    // Одинаковый ответ для неизвестного email и неверного пароля — не раскрываем наличие аккаунта.
    const ok = user ? await verifyPassword(String(b.password ?? ''), user.passwordHash) : false;
    if (!user || !ok) throw new HttpError(401, 'Неверный email или пароль');
    return { status: 200, body: { token: signToken(user.id, cfg.secret, now), user: { id: user.id, email: user.email } } };
  });

  route('GET', '/api/v1/me', { auth: true }, async ({ userId }) => {
    const user = await cfg.repo.findUserById(userId);
    if (!user) throw new HttpError(401, 'Требуется авторизация');
    return { status: 200, body: { id: user.id, email: user.email, createdAt: user.createdAt } };
  });

  route('GET', '/api/v1/me/progress', { auth: true }, async ({ userId }) => {
    const rec = await loadProgress(userId);
    return { status: 200, body: rec, headers: { etag: `"${rec.revision}"` } };
  });

  /** Полная замена с оптимистичной блокировкой: If-Match обязателен; при конфликте — 409 и актуальная версия. */
  route('PUT', '/api/v1/me/progress', { auth: true }, async ({ req, userId, body }) => {
    const ifMatch = req.headers['if-match'];
    if (!ifMatch) throw new HttpError(428, 'Требуется заголовок If-Match с ревизией прогресса');
    const expected = Number(String(ifMatch).replace(/"/g, ''));
    if (!Number.isInteger(expected) || expected < 0) throw new HttpError(400, 'Некорректный If-Match');
    const progress = parseProgress((await body()).progress);
    const saved = await cfg.repo.saveProgress(userId, progress, expected);
    if (saved === 'conflict') {
      const current = await loadProgress(userId);
      throw new HttpError(409, 'Прогресс изменён на другом устройстве', 'Объедините данные и повторите', { current });
    }
    return { status: 200, body: saved, headers: { etag: `"${saved.revision}"` } };
  });

  /** Бесконфликтная синхронизация: сервер сливает присланный прогресс с сохранённым (mergeProgress). */
  route('POST', '/api/v1/me/progress/merge', { auth: true }, async ({ userId, body }) => {
    const incoming = parseProgress((await body()).progress);
    const saved = await updateProgress(userId, (p) => mergeProgress(p, incoming));
    return { status: 200, body: saved, headers: { etag: `"${saved.revision}"` } };
  });

  route('POST', '/api/v1/exams', { auth: true }, async ({ userId, body, now }) => {
    // Экзамен выбирается по комплекту билетов; поле category поддерживается для старых клиентов.
    const b = await body();
    const bank = findTicketSet(b.ticketSet)?.bank ?? (isCategoryCode(b.category) ? categoryInfo(b.category).bank : undefined);
    if (!bank) throw new HttpError(422, 'Неизвестный комплект билетов', `Укажите ticketSet: ${TICKET_SETS.map((t) => t.code).join(' или ')}`);
    const state = createExam(banks[bank], { id: newId(), now, seed: seed(), rules: GIBDD_EXAM_RULES });
    await cfg.repo.saveExam(state.id, { userId, state });
    return { status: 201, body: examView(state, now), headers: { location: `/api/v1/exams/${state.id}` } };
  });

  route('GET', '/api/v1/exams/:id', { auth: true }, async ({ params, userId, now }) => {
    const prev = await loadExam(params.id ?? '', userId);
    const state = tickExam(prev, now);
    if (state !== prev) {
      await cfg.repo.saveExam(state.id, { userId, state });
      await updateProgress(userId, (p) => recordExam(p, examRecord(state), now));
    }
    return { status: 200, body: examView(state, now) };
  });

  route('POST', '/api/v1/exams/:id/answers', { auth: true }, async ({ params, userId, body, now }) => {
    const b = await body();
    const itemIndex = b.itemIndex;
    const option = b.option;
    if (!Number.isInteger(itemIndex) || !Number.isInteger(option)) {
      throw new HttpError(422, 'Ошибка валидации', 'itemIndex и option должны быть целыми числами');
    }
    const prev = await loadExam(params.id ?? '', userId);
    const { state, outcome } = answerExam(prev, banks[prev.bankId], itemIndex as number, option as number, now);
    await cfg.repo.saveExam(state.id, { userId, state });
    await updateProgress(userId, (p) => {
      let next = outcome ? recordAnswer(p, outcome.questionId, outcome.correct, now) : p;
      if (state.verdict !== 'in_progress') next = recordExam(next, examRecord(state), now);
      return next;
    });
    return {
      status: 200,
      body: {
        accepted: outcome !== undefined,
        ...(outcome ? { correct: outcome.correct, addedQuestions: outcome.addedQuestions, addedTimeMs: outcome.addedTimeMs } : {}),
        exam: examView(state, now),
      },
    };
  });

  // ---------- Конвейер обработки запроса ----------

  function cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (!origin) return;
    if (origins.includes('*')) res.setHeader('access-control-allow-origin', '*');
    else if (origins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
    }
    res.setHeader('access-control-expose-headers', 'etag, x-request-id, location');
  }

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}, problem = false): void {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      ...(payload ? { 'content-type': problem ? 'application/problem+json; charset=utf-8' : 'application/json; charset=utf-8' } : {}),
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(payload);
  }

  return async (req, res) => {
    const started = clock.now();
    const reqId = String(req.headers['x-request-id'] ?? '').slice(0, 64) || newId();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ip = req.socket.remoteAddress ?? 'unknown';
    res.setHeader('x-request-id', reqId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    cors(req, res);

    try {
      if (req.method === 'OPTIONS') {
        res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
        res.setHeader('access-control-allow-headers', 'authorization, content-type, if-match, if-none-match, x-request-id');
        res.setHeader('access-control-max-age', '600');
        send(res, 204, undefined);
        return;
      }
      const matched = routes.filter((r) => r.path.test(url.pathname));
      if (matched.length === 0) throw new HttpError(404, 'Ресурс не найден');
      const r = matched.find((x) => x.method === req.method);
      if (!r) throw new HttpError(405, 'Метод не поддерживается', undefined, { allow: matched.map((x) => x.method) });

      rateLimit(`${r.bucket}:${ip}`, r.bucket === 'auth' ? limits.authMax : limits.max, started);

      let userId = '';
      if (r.auth) {
        const header = req.headers.authorization ?? '';
        const claims = header.startsWith('Bearer ') ? verifyToken(header.slice(7), cfg.secret, started) : null;
        if (!claims) throw new HttpError(401, 'Требуется авторизация');
        userId = claims.sub;
      }
      const params = (r.path.exec(url.pathname)?.groups ?? {}) as Record<string, string>;
      let bodyCache: Promise<Record<string, unknown>> | undefined;
      const reply = await r.handler({
        req, res, params, reqId, now: started, userId,
        body: () => (bodyCache ??= readBody(req)),
      });
      send(res, reply.status, reply.body, reply.headers);
    } catch (err) {
      const e = toHttpError(err);
      if (e.status >= 500) log({ level: 'error', msg: 'unhandled', reqId, error: err instanceof Error ? err.stack : String(err) });
      const headers: Record<string, string> = {};
      if (e.status === 429) headers['retry-after'] = String(e.extra.retryAfterSec ?? 60);
      if (e.status === 401) headers['www-authenticate'] = 'Bearer';
      if (e.status === 405) headers.allow = (e.extra.allow as string[]).join(', ');
      send(res, e.status, {
        type: 'about:blank',
        title: e.title,
        status: e.status,
        ...(e.status < 500 && e.message !== e.title ? { detail: e.message } : {}),
        instance: reqId,
        ...Object.fromEntries(Object.entries(e.extra).filter(([k]) => k !== 'allow' && k !== 'retryAfterSec')),
      }, headers, true);
    } finally {
      log({ level: 'info', msg: 'request', reqId, method: req.method, path: url.pathname, status: res.statusCode, ms: clock.now() - started });
    }
  };
}

function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ProgressFormatError) return new HttpError(422, 'Некорректный прогресс', err.message);
  if (err instanceof DomainError) {
    const status = err.code === 'exam_finished' || err.code === 'already_answered' ? 409 : 422;
    return new HttpError(status, 'Операция отклонена', err.message, { code: err.code });
  }
  return new HttpError(500, 'Внутренняя ошибка сервера');
}
