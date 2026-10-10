import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ContentPack } from '../core/types.ts';
import { DEMO_PACK } from '../content/demo-bank.ts';
import { parsePack } from '../content/pack-io.ts';
import { createApp } from './app.ts';
import { FileRepository } from './repository.ts';

/**
 * Точка входа API. Конфигурация — только через переменные окружения (12-factor):
 *   PORT, HOST, JWT_SECRET (обязателен в production), DATA_FILE, CONTENT_FILE, CORS_ORIGINS (через запятую).
 */
const env = process.env;
const production = env.NODE_ENV === 'production';
const secret = env.JWT_SECRET ?? (production ? '' : 'dev-only-secret-change-me');
if (secret.length < 16) {
  console.error('JWT_SECRET должен быть задан и содержать не менее 16 символов');
  process.exit(1);
}

const pack: ContentPack = env.CONTENT_FILE ? parsePack(JSON.parse(await readFile(env.CONTENT_FILE, 'utf8'))) : DEMO_PACK;
const repo = await FileRepository.open(env.DATA_FILE ?? 'data/db.json');
const handler = createApp({
  repo,
  secret,
  pack,
  corsOrigins: (env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
});

const server = createServer((req, res) => void handler(req, res));
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
const port = Number(env.PORT ?? 8080);
server.listen(port, env.HOST ?? '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', msg: 'listening', port, content: pack.version }));
});

// Корректное завершение: дожидаемся текущих запросов и сбрасываем данные на диск.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ level: 'info', msg: 'shutdown', signal }));
    server.close(async () => {
      await repo.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
