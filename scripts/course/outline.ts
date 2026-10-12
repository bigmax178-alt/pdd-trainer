/**
 * Сводка курса по сценариям — для проверки всего курса целиком (скука, повторы, связность, хронометраж).
 *   node scripts/course/outline.ts   → course/reviews/OUTLINE.md и таблица метрик в консоль
 * Метрики: слова голоса (≈ хронометраж), доля [ИИ-видео] по секундам, вопросы в ролике, типы ловушек,
 * крючок, запоминалки, ссылки на другие уроки (и их корректность), размер теста, наличие версии CD.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LESSONS } from './lessons.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = join(root, 'course/scripts');
const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
const ids = new Set(LESSONS.map((l) => l.id));

const section = (text: string, title: RegExp) => {
  const m = new RegExp(`^##\\s+${title.source}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm').exec(text);
  return m?.[1] ?? '';
};
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

interface Row {
  id: string; title: string; voice: number; minutes: number; aiSec: number; totalSec: number; quizzes: number;
  traps: string[]; hook: string; mnemonic: string; refs: string[]; badRefs: string[]; test: number; cd: boolean; parts: number;
  scenes: string[];
}
const rows: Row[] = [];
for (const f of files) {
  const text = await readFile(join(dir, f), 'utf8');
  const id = f.split('-')[0] as string;
  const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? f;
  const script = section(text, /Сценарий/);
  const voiceLines = [...script.matchAll(/\*\*(?:Голос[^*]*|Если верно \(голос\))\:\*\*\s*«([^»]*)»/g)].map((m) => m[1] ?? '');
  const voice = voiceLines.reduce((n, s) => n + words(s), 0);
  let aiSec = 0, totalSec = 0;
  for (const m of script.matchAll(/\[(ИИ-видео|Схема|Наложение)[^\]]*?(\d+(?:[.,]\d+)?)\s*с\]/g)) {
    const sec = Number((m[2] ?? '0').replace(',', '.'));
    totalSec += sec;
    if (m[1] === 'ИИ-видео') aiSec += sec;
  }
  const quizzes = (script.match(/^\*\*Вопрос(?: в ролике)?(?: \([^)]*\))?:\*\*/gm) ?? []).length;
  const traps = [...new Set([...text.matchAll(/тип\s+(\d{1,2})/g)].map((m) => m[1] as string))].sort((a, b) => Number(a) - Number(b));
  const hookScene = /#{3,4}\s+Сцена\s+(?:а)?1\b[^\n]*\n([\s\S]*?)(?=#{3,4}\s)/.exec(script)?.[1] ?? '';
  const hook = /\*\*Голос[^*]*:\*\*\s*«([^»]*)»/.exec(hookScene)?.[1]?.slice(0, 160) ?? '';
  const mem = section(text, /Запоминалка/).replace(/\s+/g, ' ').slice(0, 160);
  const refs = [...new Set([...text.matchAll(/→\s*урок[а-я]*\s+((?:L|CD|BC)\d{1,2})/g)].map((m) => m[1] as string))];
  const badRefs = refs.filter((r) => !ids.has(r));
  const testSec = section(text, /Тест после урока/);
  const test = (testSec.match(/Б\d+-\d+/g) ?? []).length;
  const cd = /^##\s+Версия (CD|для переподготовки)/m.test(text);
  const parts = Math.max(1, (script.match(/^###\s+Часть|^##\s+Часть|Часть\s+[«"]?[аб]/gm) ?? []).length);
  const scenes = [...script.matchAll(/^#{3,4}\s+(.+)$/gm)].map((m) => m[1] as string);
  rows.push({ id, title, voice, minutes: voice / 140, aiSec, totalSec, quizzes, traps, hook, mnemonic: mem, refs, badRefs, test, cd, parts, scenes });
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const table = [
  '| Урок | Слов голоса | ≈ мин голоса | ИИ-видео | Вопросов в ролике | Ловушки (типы) | Тест | Версия CD | Ссылки |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.id} | ${r.voice} | ${r.minutes.toFixed(1)} | ${pct(r.aiSec, r.totalSec)} | ${r.quizzes} | ${r.traps.join(', ') || '—'} | ${r.test} | ${r.cd ? 'да' : 'НЕТ'} | ${r.refs.join(', ') || '—'}${r.badRefs.length ? ` ⚠ ${r.badRefs.join(', ')}` : ''} |`),
];
const missing = LESSONS.filter((l) => !rows.some((r) => r.id === l.id)).map((l) => l.id);
const out = [
  '# Сводка курса по сценариям',
  '',
  `Сценариев: ${rows.length} из ${LESSONS.length}${missing.length ? ` · нет: ${missing.join(', ')}` : ''}`,
  `Голос всего: ${rows.reduce((n, r) => n + r.voice, 0)} слов ≈ ${Math.round(rows.reduce((n, r) => n + r.minutes, 0))} мин (одна версия каждого урока).`,
  `Доля ИИ-видео по всему курсу: ${pct(rows.reduce((n, r) => n + r.aiSec, 0), rows.reduce((n, r) => n + r.totalSec, 0))}.`,
  '',
  '## Метрики',
  '',
  ...table,
  '',
  '## Крючки, сцены и запоминалки',
  '',
  ...rows.flatMap((r) => [
    `### ${r.title}`,
    `- **Крючок:** ${r.hook || '—'}`,
    `- **Сцены:** ${r.scenes.join(' → ')}`,
    `- **Запоминалка:** ${r.mnemonic || '—'}`,
    '',
  ]),
];
await mkdir(join(root, 'course/reviews'), { recursive: true });
await writeFile(join(root, 'course/reviews/OUTLINE.md'), out.join('\n'));
console.log(table.join('\n'));
if (missing.length) console.log(`\nНет сценариев: ${missing.join(', ')}`);
