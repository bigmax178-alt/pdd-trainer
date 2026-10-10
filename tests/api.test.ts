import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { emptyProgress, recordAnswer } from '../src/core/progress.ts';
import { DEMO_PACK } from '../src/content/demo-bank.ts';
import { signToken, verifyToken } from '../src/server/auth.ts';
import { type AppConfig, createApp } from '../src/server/app.ts';
import { FileRepository, MemoryRepository } from '../src/server/repository.ts';
import { T0 } from './fixtures.ts';

const SECRET = 'test-secret-0123456789';

async function startServer(extra: Partial<AppConfig> = {}): Promise<{ server: Server; base: string }> {
  const handler = createApp({ repo: new MemoryRepository(), secret: SECRET, pack: DEMO_PACK, log: () => {}, ...extra });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('REST API', () => {
  let server: Server;
  let base: string;
  let token = '';

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
  };

  before(async () => ({ server, base } = await startServer()));
  after(() => server.close());

  it('health, категории, контент с ETag', async () => {
    const h = await call('GET', '/api/v1/health');
    assert.equal(h.json.status, 'ok');
    assert.ok(h.headers.get('x-request-id'));
    assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
    const cats = (await call('GET', '/api/v1/categories')).json;
    assert.equal(cats.items.length, 16);
    assert.deepEqual(cats.ticketSets.map((t: { code: string }) => t.code), ['ABM', 'CD']);
    const c = await call('GET', '/api/v1/content');
    assert.equal(c.json.version, DEMO_PACK.version);
    const etag = c.headers.get('etag') ?? '';
    assert.equal((await call('GET', '/api/v1/content', undefined, { 'if-none-match': etag })).status, 304);
  });

  it('ошибки в формате problem+json: 404, 405, 415, 400', async () => {
    const nf = await call('GET', '/api/v1/nope');
    assert.equal(nf.status, 404);
    assert.equal(nf.json.status, 404);
    assert.match(nf.headers.get('content-type') ?? '', /problem\+json/);
    const m = await call('DELETE', '/api/v1/health');
    assert.equal(m.status, 405);
    assert.equal(m.headers.get('allow'), 'GET');
    assert.equal((await call('POST', '/api/v1/auth/login', 'x', { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await call('POST', '/api/v1/auth/login', '{oops')).status, 400);
  });

  it('регистрация и вход: валидация, дубликаты, неверный пароль', async () => {
    const bad = await call('POST', '/api/v1/auth/register', { email: 'нет', password: '123' });
    assert.equal(bad.status, 422);
    assert.ok(bad.json.errors.email && bad.json.errors.password);
    const ok = await call('POST', '/api/v1/auth/register', { email: 'Student@Example.com', password: 'correct horse' });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.user.email, 'student@example.com');
    assert.equal((await call('POST', '/api/v1/auth/register', { email: 'student@example.com', password: 'another pass' })).status, 409);
    const wrongPass = await call('POST', '/api/v1/auth/login', { email: 'student@example.com', password: 'nope-nope' });
    const noUser = await call('POST', '/api/v1/auth/login', { email: 'ghost@example.com', password: 'nope-nope' });
    assert.equal(wrongPass.status, 401);
    assert.deepEqual({ ...wrongPass.json, instance: '' }, { ...noUser.json, instance: '' }, 'ответ не раскрывает наличие аккаунта');
    const login = await call('POST', '/api/v1/auth/login', { email: 'STUDENT@example.com', password: 'correct horse' });
    assert.equal(login.status, 200);
    token = login.json.token;
    assert.equal((await call('GET', '/api/v1/me')).json.email, 'student@example.com');
  });

  it('токены: отсутствие, подделка и истечение срока → 401', async () => {
    const saved = token;
    token = '';
    assert.equal((await call('GET', '/api/v1/me')).status, 401);
    token = `${saved.slice(0, -2)}xx`;
    assert.equal((await call('GET', '/api/v1/me')).status, 401);
    token = signToken('u', 'other-secret-123456', Date.now());
    assert.equal((await call('GET', '/api/v1/me')).status, 401);
    token = saved;
    const expired = signToken('u', SECRET, T0, 60);
    assert.equal(verifyToken(expired, SECRET, T0 + 61_000), null);
    assert.ok(verifyToken(expired, SECRET, T0 + 1000));
  });

  it('синхронизация прогресса: If-Match, конфликт 409 и слияние', async () => {
    const empty = await call('GET', '/api/v1/me/progress');
    assert.equal(empty.json.revision, 0);
    const progress = recordAnswer(emptyProgress(T0), 'ab1-01', true, T0);
    assert.equal((await call('PUT', '/api/v1/me/progress', { progress })).status, 428);
    const put = await call('PUT', '/api/v1/me/progress', { progress }, { 'if-match': '"0"' });
    assert.equal(put.status, 200);
    assert.equal(put.json.revision, 1);
    const stale = await call('PUT', '/api/v1/me/progress', { progress }, { 'if-match': '"0"' });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.current.revision, 1);
    const other = recordAnswer(emptyProgress(T0), 'ab2-02', false, T0 + 5);
    const merged = await call('POST', '/api/v1/me/progress/merge', { progress: other });
    assert.equal(merged.json.revision, 2);
    assert.deepEqual(Object.keys(merged.json.progress.questions).sort(), ['ab1-01', 'ab2-02']);
    assert.equal((await call('POST', '/api/v1/me/progress/merge', { progress: { schemaVersion: 42 } })).status, 422);
  });

  it('серверный экзамен: ответы скрыты до конца, доп. вопросы, итог в прогрессе', async () => {
    assert.equal((await call('POST', '/api/v1/exams', { ticketSet: 'XYZ' })).status, 422);
    assert.equal((await call('POST', '/api/v1/exams', { category: 'Z' })).status, 422);
    const created = await call('POST', '/api/v1/exams', { ticketSet: 'ABM' });
    assert.equal(created.status, 201);
    const exam = created.json;
    assert.equal(exam.items.length, 20);
    assert.ok(exam.items.every((i: Record<string, unknown>) => !('correctOption' in i) && !('explanation' in i)), 'правильные ответы не раскрываются');

    const byId = new Map(DEMO_PACK.questions.map((q) => [q.id, q]));
    const correctOption = (item: { questionId: string; options: string[] }) => {
      const q = byId.get(item.questionId)!;
      return item.options.indexOf(q.options[q.correctIndex]!);
    };
    // Первая ошибка → +5 вопросов, затем всё верно.
    const first = exam.items[0];
    const wrongAns = await call('POST', `/api/v1/exams/${exam.id}/answers`, { itemIndex: 0, option: (correctOption(first) + 1) % first.options.length });
    assert.equal(wrongAns.json.correct, false);
    assert.equal(wrongAns.json.addedQuestions, 5);
    let state = wrongAns.json.exam;
    assert.equal(state.items.length, 25);
    while (state.verdict === 'in_progress') {
      const idx = state.items.findIndex((i: { answered: boolean }) => !i.answered);
      state = (await call('POST', `/api/v1/exams/${exam.id}/answers`, { itemIndex: idx, option: correctOption(state.items[idx]) })).json.exam;
    }
    assert.equal(state.verdict, 'passed');
    assert.ok(state.items.every((i: Record<string, unknown>) => typeof i.correctOption === 'number' && typeof i.explanation === 'string'), 'после завершения доступен разбор');
    const again = await call('POST', `/api/v1/exams/${exam.id}/answers`, { itemIndex: 0, option: 0 });
    assert.equal(again.status, 409);
    const progress = (await call('GET', '/api/v1/me/progress')).json.progress;
    assert.equal(progress.exams.at(-1).passed, true);
    assert.equal((await call('POST', `/api/v1/exams/${exam.id}/answers`, { itemIndex: 'x', option: 0 })).status, 422);
  });

  it('чужой экзамен недоступен', async () => {
    const mine = (await call('POST', '/api/v1/exams', { category: 'C' })).json; // старый формат запроса
    const saved = token;
    token = (await call('POST', '/api/v1/auth/register', { email: 'other@example.com', password: 'password-2' })).json.token;
    assert.equal((await call('GET', `/api/v1/exams/${mine.id}`)).status, 404);
    token = saved;
    assert.equal((await call('GET', `/api/v1/exams/${mine.id}`)).json.bankId, 'CD');
  });

  it('CORS preflight', async () => {
    const res = await fetch(`${base}/api/v1/me`, { method: 'OPTIONS', headers: { origin: 'https://app.example.org' } });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /if-match/);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

describe('REST API: защитные лимиты и хранение', () => {
  it('ограничение частоты запросов к авторизации → 429 c Retry-After', async () => {
    const { server, base } = await startServer({ rateLimit: { windowMs: 60_000, max: 100, authMax: 3 } });
    try {
      const statuses = [];
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        statuses.push(res.status);
        if (res.status === 429) assert.ok(Number(res.headers.get('retry-after')) > 0);
      }
      assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    } finally {
      server.close();
    }
  });

  it('слишком большое тело запроса → 413', async () => {
    const { server, base } = await startServer({ maxBodyBytes: 100 });
    try {
      const res = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x'.repeat(500) }) });
      assert.equal(res.status, 413);
    } finally {
      server.close();
    }
  });

  it('файловый репозиторий: атомарная запись и восстановление после перезапуска', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pdd-'));
    try {
      const file = join(dir, 'db.json');
      const repo = await FileRepository.open(file);
      assert.equal(await repo.createUser({ id: 'u1', email: 'a@b.cd', passwordHash: 'h', createdAt: 1 }), true);
      assert.equal(await repo.createUser({ id: 'u2', email: 'A@B.cd', passwordHash: 'h', createdAt: 1 }), false);
      await repo.saveProgress('u1', emptyProgress(T0), 0);
      assert.equal(await repo.saveProgress('u1', emptyProgress(T0), 0), 'conflict');
      await repo.close();
      assert.ok(JSON.parse(await readFile(file, 'utf8')).users.length === 1);
      const reopened = await FileRepository.open(file);
      assert.equal((await reopened.findUserByEmail('A@B.CD'))?.id, 'u1');
      assert.equal((await reopened.getProgress('u1'))?.revision, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
