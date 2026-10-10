/**
 * Источник официального банка билетов: открытый набор etspring/pdd_russia на зафиксированном коммите.
 * Фиксация коммита делает сборку воспроизводимой; обновление билетов — смена SHA и прогон валидации.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

export const OFFICIAL_SOURCE = {
  repo: 'etspring/pdd_russia',
  sha: 'fa37933b2ea686db47c64401773e53f6775b8df0',
  /** Версия данных из сообщения коммита: квартальное обновление ПДД. */
  version: '2026.q3.0',
} as const;

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Скачивает снимок набора (tar.gz) в vendor/, если его ещё нет. Возвращает путь к распакованной папке. */
export async function ensureOfficialSource(vendorDir: string): Promise<string> {
  const dir = join(vendorDir, `pdd_russia-${OFFICIAL_SOURCE.sha}`);
  if (await exists(join(dir, 'questions'))) return dir;
  await mkdir(vendorDir, { recursive: true });
  const url = `https://codeload.github.com/${OFFICIAL_SOURCE.repo}/tar.gz/${OFFICIAL_SOURCE.sha}`;
  console.log(`Скачиваю ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Не удалось скачать набор билетов: HTTP ${res.status}`);
  const tar = spawn('tar', ['-xzf', '-', '-C', vendorDir], { stdio: ['pipe', 'inherit', 'inherit'] });
  await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), tar.stdin);
  const [code] = (await once(tar, 'close')) as [number];
  if (code !== 0) throw new Error(`tar завершился с кодом ${code}`);
  return dir;
}

/** Файлы «Билет N.json» в порядке номеров. */
export async function readTickets(dir: string): Promise<unknown[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  files.sort((a, b) => Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0));
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as unknown));
}
