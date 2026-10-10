/**
 * Подготовка официального контента для сайта:
 *   public/content/official.json — 40 билетов ABM и 40 билетов CD с оригинальными пояснениями;
 *   public/content/signs.json    — справочник знаков ПДД;
 *   public/images/...            — только те картинки, на которые ссылаются билеты и справочник.
 * Сборка (`npm run build`) копирует public/ в dist/. Запуск: npm run fetch:official
 */
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importExternalBank } from '../src/content/pack-io.ts';
import { OFFICIAL_SOURCE, ensureOfficialSource, exists, readTickets } from './official-source.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public');
const src = await ensureOfficialSource(join(root, 'vendor'));

const { pack, issues } = importExternalBank({
  AB: await readTickets(join(src, 'questions/A_B/tickets')),
  CD: await readTickets(join(src, 'questions/C_D/tickets')),
  imageBaseUrl: './',
  version: `official-${OFFICIAL_SOURCE.version}`,
});
const errors = issues.filter((i) => i.level === 'error');
if (errors.length) {
  for (const e of errors.slice(0, 20)) console.error(`✗ ${e.message}`);
  throw new Error(`Официальный банк не прошёл проверку: ${errors.length} ошибок`);
}

// Справочник знаков: { «группа»: { «номер»: { number, title, image, description } } } → массив групп.
// Знаки без файла картинки в наборе пропускаются: показывать пустую карточку хуже, чем не показывать.
type RawSign = { number?: string; title?: string; image?: string; description?: string };
const rawSigns = JSON.parse(await readFile(join(src, 'signs/signs.json'), 'utf8')) as Record<string, Record<string, RawSign>>;
const skippedSigns: string[] = [];
const signs = [];
for (const [group, items] of Object.entries(rawSigns)) {
  const list = [];
  for (const s of Object.values(items)) {
    if (!s.number || !s.title || !s.image) continue;
    if (!(await exists(join(src, s.image)))) {
      skippedSigns.push(s.number);
      continue;
    }
    list.push({ code: s.number, title: s.title, image: s.image, description: s.description ?? '' });
  }
  if (list.length) signs.push({ group, items: list });
}

const images = new Set<string>();
for (const q of pack.questions) if (q.image?.kind === 'url') images.add(q.image.src);
const missing = [];
for (const rel of images) if (!(await exists(join(src, rel)))) missing.push(rel);
if (missing.length) throw new Error(`В наборе нет картинок к вопросам: ${missing.slice(0, 5).join(', ')}`);
for (const g of signs) for (const s of g.items) images.add(s.image);

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'content'), { recursive: true });
let bytes = 0;
for (const rel of images) {
  const to = join(out, rel);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(join(src, rel), to);
  bytes += (await stat(to)).size;
}
if (skippedSigns.length) console.warn(`! Знаки без картинки в наборе пропущены: ${skippedSigns.join(', ')}`);

await writeFile(join(out, 'content/official.json'), JSON.stringify(pack));
await writeFile(join(out, 'content/signs.json'), JSON.stringify({ source: OFFICIAL_SOURCE, groups: signs }));
console.log(`Готово: ${pack.questions.length} вопросов (билетов ABM ${pack.banks.AB.length}, CD ${pack.banks.CD.length}), `
  + `знаков ${signs.reduce((n, g) => n + g.items.length, 0)}, картинок ${images.size} (${(bytes / 1048576).toFixed(1)} МБ); `
  + `предупреждений ${issues.length - errors.length}`);
