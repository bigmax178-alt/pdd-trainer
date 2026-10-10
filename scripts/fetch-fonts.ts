/**
 * Шрифты внутри сайта (без обращений к Google Fonts, которые в РФ работают нестабильно).
 * Скачивает woff2-файлы кириллицы и латиницы для Golos Text, Unbounded и PT Mono в assets/fonts/
 * и пишет assets/fonts/fonts.css с локальными путями. Все три шрифта — под лицензией SIL OFL 1.1.
 * Результат коммитится; запуск нужен только при смене набора шрифтов.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'assets/fonts');
const FAMILIES = 'family=Golos+Text:wght@400;500;600;700&family=PT+Mono&family=Unbounded:wght@600;700';
/** Нужны только кириллица и латиница: остальные подмножества (вьетнамский, расширенная кириллица) не используются. */
const KEEP = new Set(['cyrillic', 'latin']);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const googleCss = await (await fetch(`https://fonts.googleapis.com/css2?${FAMILIES}&display=swap`, { headers: { 'user-agent': UA } })).text();
const blocks = googleCss.split('@font-face').slice(1);
await mkdir(out, { recursive: true });
// Google отдаёт один и тот же файл переменного шрифта для всех начертаний — качаем его один раз
// и объявляем диапазон весов, а не четыре копии.
interface Face { family: string; subset: string; url: string; range: string; weights: number[] }
const faces = new Map<string, Face>();
for (const block of blocks) {
  const subset = /\/\* (\w[\w-]*) \*\//.exec(block)?.[1] ?? '';
  if (!KEEP.has(subset)) continue;
  const family = /font-family: '([^']+)'/.exec(block)?.[1] ?? '';
  const weight = Number(/font-weight: (\d+)/.exec(block)?.[1] ?? '400');
  const url = /url\(([^)]+\.woff2)\)/.exec(block)?.[1];
  const range = /unicode-range: ([^;]+);/.exec(block)?.[1] ?? '';
  if (!family || !url) continue;
  const face = faces.get(url) ?? { family, subset, url, range, weights: [] };
  face.weights.push(weight);
  faces.set(url, face);
}
const css = [];
for (const f of faces.values()) {
  const lo = Math.min(...f.weights), hi = Math.max(...f.weights);
  const file = `${f.family.toLowerCase().replace(/\s+/g, '-')}-${lo === hi ? lo : `${lo}-${hi}`}-${f.subset}.woff2`;
  const res = await fetch(f.url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`Не удалось скачать ${f.url}: HTTP ${res.status}`);
  await writeFile(join(out, file), Buffer.from(await res.arrayBuffer()));
  css.push(`@font-face{font-family:'${f.family}';font-style:normal;font-weight:${lo === hi ? lo : `${lo} ${hi}`};font-display:swap;src:url(fonts/${file}) format('woff2');unicode-range:${f.range}}`);
}
await writeFile(join(out, 'fonts.css'), `${css.join('\n')}\n`);
await writeFile(join(out, 'LICENSE.md'), `Шрифты Golos Text (Paratype), Unbounded (Nameless Foundry) и PT Mono (Paratype)
распространяются по лицензии SIL Open Font License 1.1: https://openfontlicense.org/
Файлы получены из Google Fonts и используются без изменений.
`);
console.log(`Готово: ${faces.size} файлов шрифтов → assets/fonts/`);
