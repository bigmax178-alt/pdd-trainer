/**
 * Текст пунктов ПДД для сценаристов и проверяющих.
 *   node scripts/course/rule.ts 13.11 13.12      — пункты
 *   node scripts/course/rule.ts 13               — весь раздел
 *   node scripts/course/rule.ts --find "50 м"    — поиск по тексту
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RuleBook, parseRuleBook } from '../../src/content/rules.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const book: RuleBook = parseRuleBook(JSON.parse(await readFile(join(root, 'public/content/rules.json'), 'utf8')));
const args = process.argv.slice(2);
console.log(`ПДД РФ — ${book.edition}\n`);

if (args[0] === '--find') {
  const needle = (args[1] ?? '').toLowerCase().replace(/ё/g, 'е');
  for (const s of book.sections) {
    for (const i of s.items) {
      const t = i.text.toLowerCase().replace(/ё/g, 'е');
      const at = t.indexOf(needle);
      if (at >= 0) console.log(`п. ${i.num} (разд. ${s.num}): …${i.text.slice(Math.max(0, at - 120), at + 200)}…\n`);
    }
  }
} else {
  for (const a of args) {
    const section = book.sections.find((s) => s.num === a);
    if (section) {
      console.log(`== Раздел ${section.num}. ${section.title}`);
      for (const i of section.items) console.log(`\n${i.num}. ${i.text}`);
      continue;
    }
    const hit = book.sections.flatMap((s) => s.items.map((i) => ({ s, i }))).find(({ i }) => i.num === a);
    console.log(hit ? `п. ${hit.i.num} (раздел ${hit.s.num}. ${hit.s.title}):\n${hit.i.text}\n` : `п. ${a}: не найден\n`);
  }
}
