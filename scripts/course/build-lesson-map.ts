/**
 * Карта курса: каждый вопрос ABM и CD закрепляется ровно за одним уроком.
 *   course/map/lesson-map.json       — уроки, вопросы и статистика покрытия
 *   course/map/questions/<урок>.md   — подборка вопросов урока для сценариста
 * Запуск: node scripts/course/build-lesson-map.ts (нужен public/content/official.json — npm run fetch:official)
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentPack, Question } from '../../src/core/types.ts';
import { stems } from '../../src/core/similar.ts';
import { type Lesson, LESSONS } from './lessons.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pack = JSON.parse(await readFile(join(root, 'public/content/official.json'), 'utf8')) as ContentPack;
const byId = new Map(pack.questions.map((q) => [q.id, q]));

// ---------- Признаки вопроса ----------

const SIGN_RE = /знак\S*\s+((?:\d\.\d{1,2}(?:\.\d{1,2})?)(?:\s*(?:,|и|-|–|или)\s*\d\.\d{1,2}(?:\.\d{1,2})?)*)/gi;

function signsOf(q: Question): string[] {
  const out: string[] = [];
  for (const m of `${q.text} ${q.explanation}`.matchAll(SIGN_RE)) {
    for (const c of (m[1] ?? '').split(/[^\d.]+/).filter(Boolean)) out.push(c.replace(/\.$/, ''));
  }
  return out;
}

const num = (code: string) => code.split('.').map(Number);
function cmp(a: string, b: string): number {
  const x = num(a), y = num(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return d;
  }
  return 0;
}
/** Код в диапазоне [lo, hi]: ['3.18','3.33'] или группа ['1','1'] / ['6','8']. */
function inRange(code: string, [lo, hi]: readonly [string, string]): boolean {
  if (!lo.includes('.') && !hi.includes('.')) {
    const g = Number(code.split('.')[0]);
    return g >= Number(lo) && g <= Number(hi);
  }
  const head = code.split('.').slice(0, 2).join('.');
  return cmp(head, lo) >= 0 && cmp(head, hi) <= 0;
}
const refHit = (refs: readonly string[], want: readonly string[]) =>
  refs.some((r) => want.some((w) => r === w || r.startsWith(`${w}.`)));

function score(l: Lesson, q: Question, signs: string[]): number {
  const m = l.match;
  if (!m) return 0;
  let s = 0;
  if (m.refs && refHit(q.ruleRefs ?? [], m.refs)) s += 4;
  // Для знаков решает первый упомянутый знак — вопрос «про него».
  if (m.signRanges && signs[0] && m.signRanges.some((r) => inRange(signs[0] as string, r))) s += 5;
  else if (m.signRanges && signs.some((c) => m.signRanges!.some((r) => inRange(c, r)))) s += 2;
  if (m.kw && m.kw.test(`${q.text} ${q.explanation}`)) s += m.kwWeight ?? 2;
  return s;
}

function assign(q: Question, candidates: readonly Lesson[]): Lesson | undefined {
  const topic = q.topicIds[0] ?? 'general';
  const pool = candidates.filter((l) => l.topics.includes(topic));
  if (!pool.length) return undefined;
  const signs = signsOf(q);
  let best: Lesson | undefined;
  let bestScore = 0;
  for (const l of pool) {
    const s = score(l, q, signs);
    if (s > bestScore) { best = l; bestScore = s; }
  }
  return best ?? pool.find((l) => l.isDefault) ?? pool[0];
}

// ---------- Вопросы CD: совпадают, «тот же вопрос с другой картинкой» или отличаются по смыслу ----------

const position = new Map<string, { bank: 'AB' | 'CD'; ticket: number; pos: number }[]>();
for (const bank of ['AB', 'CD'] as const) {
  for (const t of pack.banks[bank]) {
    t.questionIds.forEach((id, i) => {
      position.set(id, [...(position.get(id) ?? []), { bank, ticket: t.number, pos: i + 1 }]);
    });
  }
}
const abIds = pack.banks.AB.flatMap((t) => t.questionIds);
const cdIds = pack.banks.CD.flatMap((t) => t.questionIds);
const abSet = new Set(abIds);
const jac = (a: Set<string>, b: Set<string>) => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i || 1);
};
// «Подпись» ответа: числа, буквы-варианты (А, Б, В, Г) и полярность (разрешено / запрещено).
function answerSignature(ans: string): string {
  const a = ans.toLowerCase().replace(/ё/g, 'е');
  const nums = (a.match(/\d+(?:[.,]\d+)?/g) ?? []).map((x) => x.replace(',', '.'));
  const letters = (ans.match(/(?:^|[^А-Яа-яЁё])([АБВГ])(?![А-Яа-яЁё])/g) ?? []).map((x) => x.trim().slice(-1));
  const polarity = /(^|\s)не\s+(разреш|допуска|можно|долж|обяза)|запрещ|нельзя/.test(a) ? 'NO' : /разреш|можно|допуска|должн|обязан/.test(a) ? 'YES' : '';
  return [...nums, ...letters.sort(), polarity].join('|');
}
function sameAnswer(x: Question, y: Question): boolean {
  const ax = x.options[x.correctIndex] ?? '', ay = y.options[y.correctIndex] ?? '';
  const sx = answerSignature(ax), sy = answerSignature(ay);
  if (sx.replace(/\|/g, '') || sy.replace(/\|/g, '')) return sx === sy;
  return jac(stems(ax), stems(ay)) >= 0.7;
}
/** Вопрос явно про тяжёлую машину: грузовик, автобус, массу, прицеп, категории N2/N3/M2/M3. */
const HEAVY = /грузов|автобус|масс[аыуеой]|3,5\s*т|прицеп|автопоезд|тягач|тахограф|кузов|троллейбус|габарит|[NМM][23]\b|категори[ийя]\s*[«"]?[CDСД]/i;

const abTextTokens = abIds.map((id) => ({ id, t: stems((byId.get(id) as Question).text), q: byId.get(id) as Question }));
// Билеты CD построены параллельно ABM: CD Б33-1 — двойник ABM Б33-1, где «легковой автомобиль» или «мотоцикл»
// заменены на «маломестный автобус» или «грузовой автомобиль». Если варианты после такой замены совпадают
// и правильный ответ тот же — это общее правило, а не отличие C/D.
const vehicle = (s: string) => s.toLowerCase().replace(/ё/g, 'е')
  .replace(/маломестн\S*\s+автобус\S*|легков\S*\s+автомобил\S*|грузов\S*\s+автомобил\S*|мотоцикл\S*|автомобил\S*|транспортн\S+\s+средств\S*/g, 'ТС')
  .replace(/[«»"().,:;!?]/g, ' ').replace(/\s+/g, ' ').trim();
function positionalTwin(cdId: string): Question | undefined {
  const at = (position.get(cdId) ?? []).find((x) => x.bank === 'CD');
  const abId = at && pack.banks.AB.find((t) => t.number === at.ticket)?.questionIds[at.pos - 1];
  const a = abId ? byId.get(abId) : undefined;
  const c = byId.get(cdId) as Question;
  if (!a || a.correctIndex !== c.correctIndex || a.options.length !== c.options.length) return undefined;
  return c.options.every((o, i) => vehicle(o) === vehicle(a.options[i] ?? '')) ? a : undefined;
}
type Relation =
  | { kind: 'same' }
  | { kind: 'near'; abId: string; sim: number }
  | { kind: 'own' }
  | { kind: 'distinct' };
const cdRelation = new Map<string, Relation>();
for (const id of cdIds) {
  if (abSet.has(id)) { cdRelation.set(id, { kind: 'same' }); continue; }
  const q = byId.get(id) as Question;
  const t = stems(q.text);
  // «Близнец» — похожий текст И тот же по смыслу ответ; среди похожих берём лучший с совпадающим ответом.
  let best: { id: string; s: number } | undefined;
  for (const a of abTextTokens) {
    const s = jac(t, a.t);
    if (s >= 0.6 && sameAnswer(q, a.q) && (!best || s > best.s)) best = { id: a.id, s };
  }
  // Есть двойник ABM с тем же ответом — правило общее, даже если на картинке грузовик.
  // Нет двойника и вопрос про тяжёлую машину — это отличие C/D; иначе — своя ситуация на общие правила.
  const twin = best ? undefined : positionalTwin(id);
  if (best) cdRelation.set(id, { kind: 'near', abId: best.id, sim: best.s });
  else if (twin) cdRelation.set(id, { kind: 'near', abId: twin.id, sim: jac(t, stems(twin.text)) });
  else if (HEAVY.test(`${q.text} ${q.options.join(' ')}`)) cdRelation.set(id, { kind: 'distinct' });
  else cdRelation.set(id, { kind: 'own' });
}

// ---------- Распределение ----------

const shared = LESSONS.filter((l) => !l.cdDistinct && l.topics.length);
const cdOnly = LESSONS.filter((l) => l.cdDistinct);
const lessonOf = { AB: new Map<string, string>(), CD: new Map<string, string>() };
const unassigned: string[] = [];
for (const id of abIds) {
  const l = assign(byId.get(id) as Question, shared);
  if (l) lessonOf.AB.set(id, l.id); else unassigned.push(`AB ${id}`);
}
for (const id of cdIds) {
  const rel = cdRelation.get(id) as Relation;
  const q = byId.get(id) as Question;
  // Совпадающие и «близнецы» CD учатся в общих уроках; отличающиеся по смыслу — в уроках отличий.
  const l = rel.kind === 'distinct' ? assign(q, cdOnly) ?? cdOnly.find((x) => x.id === 'CD5') : assign(q, shared);
  // Вопросы без темы в уроках отличий (например, перекрёстки) уходят в ближайший по смыслу урок CD через тему.
  if (l) lessonOf.CD.set(id, l.id); else unassigned.push(`CD ${id}`);
}

// ---------- Вывод ----------

const outDir = join(root, 'course/map');
await rm(join(outDir, 'questions'), { recursive: true, force: true });
await mkdir(join(outDir, 'questions'), { recursive: true });

const where = (id: string, bank: 'AB' | 'CD') => position.get(id)?.find((p) => p.bank === bank);
const loc = (id: string, bank: 'AB' | 'CD') => {
  const p = where(id, bank);
  return p ? `Б${p.ticket} В${p.pos}` : '';
};
const signsUrl = new Map<string, string>();
try {
  const cat = JSON.parse(await readFile(join(root, 'public/content/signs.json'), 'utf8')) as { groups: { items: { code: string; image: string }[] }[] };
  for (const g of cat.groups) for (const s of g.items) signsUrl.set(s.code, s.image);
} catch { /* справочник знаков необязателен */ }

function questionBlock(id: string, bank: 'AB' | 'CD'): string {
  const q = byId.get(id) as Question;
  const img = q.image?.kind === 'url' ? q.image.src : '';
  const signs = [...new Set(signsOf(q))];
  return [
    `### ${loc(id, bank)} · \`${id}\``,
    `**Вопрос:** ${q.text}`,
    ...q.options.map((o, i) => `${i === q.correctIndex ? '- ✅' : '- ▫️'} ${i + 1}. ${o}`),
    `**Пояснение:** ${q.explanation.replace(/\s+/g, ' ').trim()}`,
    `**Пункты ПДД:** ${(q.ruleRefs ?? []).join(', ') || '—'} · **Знаки:** ${signs.join(', ') || '—'} · **Картинка:** ${img || 'нет'}`,
    '',
  ].join('\n');
}

const lessonsOut = [];
for (const l of LESSONS) {
  const ab = abIds.filter((id) => lessonOf.AB.get(id) === l.id);
  const cdAll = cdIds.filter((id) => lessonOf.CD.get(id) === l.id);
  const cdNew = cdAll.filter((id) => cdRelation.get(id)?.kind === 'distinct');
  const cdSame = cdAll.filter((id) => cdRelation.get(id)?.kind === 'same');
  const cdNear = cdAll.filter((id) => cdRelation.get(id)?.kind === 'near');
  const cdOwn = cdAll.filter((id) => cdRelation.get(id)?.kind === 'own');
  lessonsOut.push({ ...l, match: undefined, questions: { ABM: ab, CD: cdAll }, counts: { ABM: ab.length, CD: cdAll.length, CDsame: cdSame.length, CDnear: cdNear.length, CDown: cdOwn.length, CDdistinct: cdNew.length } });

  const md: string[] = [
    `# ${l.id}. ${l.title}`,
    '',
    `Курсы: ${l.courses.join(', ')} · Вопросов ABM: ${ab.length} · Вопросов CD: ${cdAll.length} (совпадают с ABM: ${cdSame.length}, тот же вопрос и ответ с другой картинкой: ${cdNear.length}, своя ситуация CD на те же правила: ${cdOwn.length}, отличаются для тяжёлых машин: ${cdNew.length})`,
    '',
    `**Фокус урока:** ${l.focus}`,
    '',
    'Сценарий обязан объяснить правило, на котором стоит КАЖДЫЙ вопрос ниже. Ученик после урока должен правильно ответить на любой из них.',
    '',
  ];
  if (ab.length) {
    md.push(`## Вопросы ABM (${ab.length})`, '');
    for (const id of ab) md.push(questionBlock(id, 'AB'));
  }
  if (cdOwn.length) {
    md.push(`## Вопросы CD со своей ситуацией (${cdOwn.length})`, '',
      'Похожего вопроса с тем же ответом в ABM нет, но правило то же, что для легковых. Проверьте ответ по картинке CD.', '');
    for (const id of cdOwn) md.push(questionBlock(id, 'CD'));
  }
  if (cdNew.length) {
    md.push(`## Вопросы CD, отличающиеся от ABM по смыслу (${cdNew.length})`, '');
    for (const id of cdNew) md.push(questionBlock(id, 'CD'));
  }
  if (cdNear.length || cdSame.length) {
    md.push(`## Вопросы CD, которые повторяют вопросы ABM (${cdNear.length + cdSame.length})`, '',
      'Тот же вопрос и тот же по смыслу правильный ответ, другая картинка (обычно грузовик или автобус) или чуть другая формулировка. Для версии CD берите примеры отсюда.', '');
    for (const id of cdSame) md.push(`- ${loc(id, 'CD')} · \`${id}\` — совпадает с ABM ${loc(id, 'AB')}`);
    for (const id of cdNear) {
      const rel = cdRelation.get(id) as { abId: string };
      const q = byId.get(id) as Question;
      const img = q.image?.kind === 'url' ? ` · картинка ${q.image.src}` : '';
      md.push(`- ${loc(id, 'CD')} · \`${id}\` ≈ ABM ${loc(rel.abId, 'AB')} \`${rel.abId}\` — «${q.text.slice(0, 90)}${q.text.length > 90 ? '…' : ''}» → ✅ ${q.options[q.correctIndex]}${img}`);
    }
    md.push('');
  }
  await writeFile(join(outDir, 'questions', `${l.id}.md`), md.join('\n'));
}

const summary = {
  generatedFrom: pack.version,
  totals: {
    ABM: abIds.length, CD: cdIds.length,
    CDsame: [...cdRelation.values()].filter((r) => r.kind === 'same').length,
    CDnear: [...cdRelation.values()].filter((r) => r.kind === 'near').length,
    CDown: [...cdRelation.values()].filter((r) => r.kind === 'own').length,
    CDdistinct: [...cdRelation.values()].filter((r) => r.kind === 'distinct').length,
  },
  unassigned,
  signImages: Object.fromEntries(signsUrl),
  lessons: lessonsOut,
};
await mkdir(dirname(join(outDir, 'lesson-map.json')), { recursive: true });
await writeFile(join(outDir, 'lesson-map.json'), JSON.stringify(summary, null, 1));

console.log(`Вопросов ABM: ${abIds.length}, CD: ${cdIds.length}; не распределено: ${unassigned.length}`);
console.log(`CD: совпадают ${summary.totals.CDsame}, «близнецы» ${summary.totals.CDnear}, своя ситуация ${summary.totals.CDown}, отличаются для тяжёлых машин ${summary.totals.CDdistinct}`);
for (const l of lessonsOut) console.log(`${l.id.padEnd(4)} ABM ${String(l.counts.ABM).padStart(3)} | CD ${String(l.counts.CD).padStart(3)} (новых ${l.counts.CDdistinct}) | ${l.title}`);
