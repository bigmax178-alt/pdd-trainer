/**
 * Текст ПДД РФ для раздела «Правила» и переходов из пояснений (public/content/rules.json).
 *
 * Источник — открытый набор newzealandgrom/pddcourse (data/rules.json) на зафиксированном коммите:
 * редакция с изменениями, вступившими в силу 01.09.2025 (п. 2.1.1 содержит предъявление документов
 * через QR-код Госуслуг). Текст ПДД — официальный документ и объектом авторского права не является.
 * При обновлении правил: сменить SHA, прогнать скрипт и проверить ключевые пункты.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RuleBook, type RuleSection, parseRuleBook } from '../src/content/rules.ts';

export const RULES_SOURCE = {
  repo: 'newzealandgrom/pddcourse',
  sha: '779cea5f44b6d28c03a2f994064d3e53861f83bf',
  path: 'data/rules.json',
  edition: 'Редакция ПДД с изменениями от 01.09.2025',
} as const;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = `https://raw.githubusercontent.com/${RULES_SOURCE.repo}/${RULES_SOURCE.sha}/${RULES_SOURCE.path}`;
const res = await fetch(url);
if (!res.ok) throw new Error(`Не удалось скачать текст ПДД: HTTP ${res.status}`);
const raw = (await res.json()) as { num: string | null; title: string; items: { num: string | null; text: string }[] }[];

const clean = (t: string) => t.replace(/ /g, ' ').replace(/\s*\*\s*/g, ' ').replace(/\s+/g, ' ').trim();
const sections: RuleSection[] = [];
for (const s of raw) {
  if (!Array.isArray(s.items)) continue;
  const main = s.num !== null && /^\d{1,2}$/.test(String(s.num));
  // Приложения с собственной нумерацией («1.1» разметки ≠ «1.1» Правил) получают префикс и не попадают в ссылки.
  const prefix = main ? '' : s.title.startsWith('Приложение 2') ? 'Р.' : s.title.startsWith('Основные положения') ? 'ОП.' : 'ПН.';
  const items = s.items
    .filter((i) => i.num && i.text)
    .map((i) => ({ num: `${prefix}${String(i.num)}`, text: clean(i.text) }))
    .filter((i) => i.text.length > 0);
  const num = main ? String(s.num) : prefix.slice(0, -1);
  const existing = sections.find((x) => x.num === num);
  if (existing) sections[sections.indexOf(existing)] = { ...existing, items: [...existing.items, ...items] };
  else sections.push({ num, title: clean(s.title), items });
}

const book: RuleBook = parseRuleBook({
  source: `открытый набор ${RULES_SOURCE.repo} (коммит ${RULES_SOURCE.sha.slice(0, 7)})`,
  edition: RULES_SOURCE.edition,
  sections,
});

// Контрольные точки: без них версия могла бы незаметно откатиться к старой редакции.
const byNum = new Map(book.sections.flatMap((s) => s.items.map((i) => [i.num, i.text] as const)));
const checks: [string, RegExp][] = [
  ['1.2', /средство индивидуальной мобильности/i],
  ['2.1.1', /штрихового кода/],
  ['10.2', /20 км\/ч/],
  ['13.11', /приближающимся справа/],
  ['22.9', /младше 7 лет/],
];
for (const [num, re] of checks) {
  if (!re.test(byNum.get(num) ?? '')) throw new Error(`Контрольная точка не прошла: пункт ${num} не содержит ${re}`);
}

const out = join(root, 'public/content/rules.json');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(book));
console.log(`Готово: ${book.sections.length} разделов, ${byNum.size} пунктов → ${out}`);
