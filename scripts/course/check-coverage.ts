/**
 * Проверка покрытия билетов сценариями.
 * Каждый вопрос, закреплённый картой за уроком, должен стоять в таблице «## Покрытие билетов» сценария этого урока
 * (колонка ABM — номера по билетам ABM, колонка CD — по билетам CD, формат «Б7-14»).
 *   node scripts/course/check-coverage.ts            — все сценарии
 *   node scripts/course/check-coverage.ts L17 L29    — выбранные
 * Код выхода 1, если есть непокрытые или неверные ссылки.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentPack } from '../../src/core/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pack = JSON.parse(await readFile(join(root, 'public/content/official.json'), 'utf8')) as ContentPack;
const map = JSON.parse(await readFile(join(root, 'course/map/lesson-map.json'), 'utf8')) as {
  lessons: { id: string; title: string; questions: { ABM: string[]; CD: string[] } }[];
};
const idAt = (bank: 'AB' | 'CD', t: number, p: number) => pack.banks[bank].find((x) => x.number === t)?.questionIds[p - 1];

const dir = join(root, 'course/scripts');
const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.md'));
const want = process.argv.slice(2);
let problems = 0;
let checked = 0;
const report: string[] = [];

for (const lesson of map.lessons) {
  if (want.length && !want.includes(lesson.id)) continue;
  const file = files.find((f) => f.startsWith(`${lesson.id}-`) || f === `${lesson.id}.md`);
  const need = lesson.questions.ABM.length + lesson.questions.CD.length;
  if (!file) {
    if (want.length || need) report.push(`✗ ${lesson.id}: нет сценария`);
    if (need) problems++;
    continue;
  }
  checked++;
  const text = await readFile(join(dir, file), 'utf8');
  const sec = /^##\s+Покрытие билетов\s*$([\s\S]*?)(?=^##\s|\Z)/m.exec(text)?.[1] ?? '';
  const covered = { AB: new Set<string>(), CD: new Set<string>() };
  const bad: string[] = [];
  for (const line of sec.split('\n')) {
    if (!line.startsWith('|') || /^\|\s*-/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 5 || cells[0] === '#') continue;
    const cols: ['AB' | 'CD', string][] = [['AB', cells[cells.length - 2] ?? ''], ['CD', cells[cells.length - 1] ?? '']];
    for (const [bank, cell] of cols) {
      for (const m of cell.matchAll(/Б(\d+)-(\d+)/g)) {
        const id = idAt(bank, Number(m[1]), Number(m[2]));
        if (!id) bad.push(`${bank === 'AB' ? 'ABM' : 'CD'} ${m[0]} — нет такого вопроса`);
        else covered[bank].add(id);
      }
    }
  }
  const missAB = lesson.questions.ABM.filter((id) => !covered.AB.has(id));
  const missCD = lesson.questions.CD.filter((id) => !covered.CD.has(id));
  const foreignAB = [...covered.AB].filter((id) => !lesson.questions.ABM.includes(id));
  const foreignCD = [...covered.CD].filter((id) => !lesson.questions.CD.includes(id));
  const where = (bank: 'AB' | 'CD', id: string) => {
    for (const t of pack.banks[bank]) {
      const i = t.questionIds.indexOf(id);
      if (i >= 0) return `Б${t.number}-${i + 1}`;
    }
    return id;
  };
  const ok = !missAB.length && !missCD.length && !bad.length;
  if (!ok) problems++;
  report.push(`${ok ? '✓' : '✗'} ${lesson.id} ${file}: ABM ${lesson.questions.ABM.length - missAB.length}/${lesson.questions.ABM.length}, CD ${lesson.questions.CD.length - missCD.length}/${lesson.questions.CD.length}`
    + (missAB.length ? `\n    не покрыты ABM: ${missAB.map((id) => where('AB', id)).join(', ')}` : '')
    + (missCD.length ? `\n    не покрыты CD: ${missCD.map((id) => where('CD', id)).join(', ')}` : '')
    + (bad.length ? `\n    ошибки ссылок: ${bad.join('; ')}` : '')
    + (foreignAB.length || foreignCD.length ? `\n    (вопросы других уроков, допустимо как повтор: ABM ${foreignAB.length}, CD ${foreignCD.length})` : ''));
}
console.log(report.join('\n'));
console.log(`\nПроверено сценариев: ${checked}; с проблемами: ${problems}`);
process.exit(problems ? 1 : 0);
