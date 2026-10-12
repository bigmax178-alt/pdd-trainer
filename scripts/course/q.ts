/**
 * Вопрос билета по номеру — для сценаристов и проверяющих.
 *   node scripts/course/q.ts ABM 7 14     — комплект ABM, билет 7, вопрос 14
 *   node scripts/course/q.ts CD 34 12
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentPack } from '../../src/core/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pack = JSON.parse(await readFile(join(root, 'public/content/official.json'), 'utf8')) as ContentPack;
const [set, t, p] = process.argv.slice(2);
const bank = set?.toUpperCase().startsWith('C') ? 'CD' : 'AB';
const id = pack.banks[bank].find((x) => x.number === Number(t))?.questionIds[Number(p) - 1];
const q = pack.questions.find((x) => x.id === id);
if (!q) {
  console.error('Использование: node scripts/course/q.ts ABM|CD <билет> <вопрос>');
  process.exit(2);
}
console.log(`${bank === 'AB' ? 'ABM' : 'CD'} Б${t}-${p} · ${q.id}`);
console.log(`Вопрос: ${q.text}`);
q.options.forEach((o, i) => console.log(`${i === q.correctIndex ? '✅' : '  '} ${i + 1}. ${o}`));
console.log(`Пояснение: ${q.explanation}`);
console.log(`Пункты ПДД: ${(q.ruleRefs ?? []).join(', ') || '—'}`);
console.log(`Картинка: ${q.image?.kind === 'url' ? `public/${q.image.src.replace(/^\.\//, '')}` : 'нет'}`);
