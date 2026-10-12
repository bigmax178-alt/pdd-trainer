/**
 * Сценарии курса → PDF по блокам для чтения (формат A5 — удобно и с телефона, и с компьютера).
 *   node scripts/course/to-pdf.ts              → course/pdf/00 … 13 *.pdf
 *   node scripts/course/to-pdf.ts --out <папка>
 * Нужен Google Chrome (печать в PDF без окна); путь можно задать переменной CHROME.
 * Каждый файл: обложка с оглавлением и легендой пометок → уроки, каждый с новой страницы.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const scriptsDir = join(root, 'course/scripts');
const reviewsDir = join(root, 'course/reviews');
const outArg = process.argv.indexOf('--out');
const outDir = outArg > 0 ? (process.argv[outArg + 1] as string) : join(root, 'course/pdf');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

interface Block { n: string; title: string; about: string; ids: string[] }
const BLOCKS: Block[] = [
  { n: '01', title: 'Основы', about: 'Как устроены экзамен и курс, термины, обязанности водителя и ДТП, спецмашины и аварийка', ids: ['L00', 'L01', 'L02', 'L03'] },
  { n: '02', title: 'Знаки, часть 1', about: 'Как читать знаки, предупреждающие, знаки приоритета, запрещающие', ids: ['L04', 'L05', 'L06', 'L07', 'L08'] },
  { n: '03', title: 'Знаки, часть 2', about: 'Знаки остановки и стоянки, предписывающие, особых предписаний, информационные, сервиса, таблички', ids: ['L09', 'L10', 'L11', 'L12', 'L13'] },
  { n: '04', title: 'Разметка, светофор, регулировщик', about: 'Линии разметки и подсказки на асфальте, сигналы светофора, жесты регулировщика', ids: ['L14', 'L15', 'L16', 'L17'] },
  { n: '05', title: 'Манёвры', about: 'Сигналы поворота, перестроение и выезд с прилегающей территории, повороты, разворот и задний ход', ids: ['L18', 'L19', 'L20', 'L21'] },
  { n: '06', title: 'Полосы, скорость, обгон', about: 'Расположение на дороге и дистанция, скорость, обгон, опережение, встречный разъезд', ids: ['L22', 'L23', 'L24'] },
  { n: '07', title: 'Остановка и стоянка', about: 'Где и как можно стоять, где нельзя', ids: ['L25', 'L26'] },
  { n: '08', title: 'Перекрёстки', about: 'Регулируемый, неравнозначный, равнозначный и трамвай, сложные перекрёстки', ids: ['L27', 'L28', 'L29', 'L30'] },
  { n: '09', title: 'Пешеходы, переезды, автомагистраль', about: 'Пешеходы и маршрутные ТС, железнодорожный переезд, автомагистраль и жилая зона', ids: ['L31', 'L32', 'L33'] },
  { n: '10', title: 'Машина и безопасность', about: 'Фары и звуковой сигнал, буксировка и перевозка, неисправности, техника управления, безопасность', ids: ['L34', 'L35', 'L36', 'L37', 'L38'] },
  { n: '11', title: 'Первая помощь, ответственность, экзамен', about: 'Первая помощь, ответственность водителя, экзаменационная страховка — финал курса', ids: ['L39', 'L40', 'L41'] },
  { n: '12', title: 'Грузовые и автобусы: уроки отличий', about: 'Только для категорий C, D и переподготовки B → C: вопросы, где ответ для тяжёлых машин не такой, как для легковых', ids: ['CD1', 'CD2', 'CD3', 'CD4', 'CD5'] },
  { n: '13', title: 'Переподготовка B → C', about: 'Вводный и итоговый уроки. Основная часть переподготовки — уроки отличий CD1–CD5 из файла 12', ids: ['BC0', 'BC6'] },
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const TAG: Record<string, string> = { 'ИИ-видео': 'ai', 'Схема': 'scheme', 'Наложение': 'overlay' };

function inline(s: string): string {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[\s(«])\*([^*\s][^*]*?)\*(?=[\s).,;:!?»]|$)/g, '$1<em>$2</em>');
  h = h.replace(/\[(ИИ-видео|Схема|Наложение)([^\]]*)\]/g, (_m, t: string, rest: string) => `<span class="tag ${TAG[t]}">${t}${rest}</span>`);
  return h;
}

function lineClass(raw: string): string {
  if (/^\*\*Голос/.test(raw)) return 'voice';
  if (/^\*\*Если верно/.test(raw)) return 'fb good';
  if (/^\*\*Если неверно/.test(raw)) return 'fb bad';
  const shot = /^\*\*Кадр[^*]*\[(ИИ-видео|Схема|Наложение)/.exec(raw);
  if (shot) return `shot ${TAG[shot[1] as string]}`;
  if (/^\*\*Кадр/.test(raw)) return 'shot';
  if (/^\*\*На экране/.test(raw)) return 'screen';
  if (/^\*\*(Вопрос|Пауза)/.test(raw)) return 'quiz';
  if (/^\*\*(Звук|Музыка)/.test(raw)) return 'sound';
  return '';
}

function sectionOf(title: string): { cls: string; label: string; note: string } {
  const t = title.trim();
  if (/^Сценарий \(версия ABM\)/.test(t)) return { cls: 'main', label: 'Сценарий ролика · легковые (A, B, M)', note: 'Основная версия. Читается сверху вниз — так, как идёт ролик.' };
  if (/^Сценарий \(версия CD\)/.test(t)) return { cls: 'main cd', label: 'Сценарий ролика · грузовые и автобусы (C, D)', note: 'Урок только для категорий C, D и переподготовки B → C.' };
  if (/^Сценарий \(версия BC\)/.test(t)) return { cls: 'main bc', label: 'Сценарий ролика · переподготовка B → C', note: 'Урок курса переподготовки для водителей легковых.' };
  if (/^Версия CD/.test(t)) return { cls: 'cdv', label: 'Версия для грузовых и автобусов (C, D)', note: 'Не отдельный сценарий: что заменить в ролике выше, чтобы получилась версия для C, D. Номера слева — номера сцен.' };
  if (/^Версия для переподготовки/.test(t)) return { cls: 'bcv', label: 'Версия для переподготовки B → C', note: 'Что изменить в ролике выше для водителей легковых, которые переучиваются на грузовик.' };
  if (/^Запоминалка/.test(t)) return { cls: 'short', label: t, note: 'Отдельный короткий вертикальный ролик для повторения перед экзаменом.' };
  if (/^Тест после урока/.test(t)) return { cls: 'test', label: t, note: 'Вопросы билетов, которые ученик решает в приложении после ролика.' };
  if (/^Покрытие билетов/.test(t)) return { cls: 'tech', label: 'Покрытие билетов (служебное)', note: 'Какие вопросы билетов разбирает урок: ABM — билеты для легковых, CD — для грузовых. «Б28-6» — билет 28, вопрос 6.' };
  if (/^Факты/.test(t)) return { cls: 'tech', label: 'Факты, сверенные с ПДД (служебное)', note: 'Для проверяющих и инструктора: откуда взято каждое правило и что спорно.' };
  if (/^Что ученик умеет/.test(t)) return { cls: 'goal', label: 'Что ученик умеет после урока', note: '' };
  return { cls: 'plain', label: t, note: '' };
}

/** Markdown сценария → HTML. Каждая строка — отдельный абзац: «Голос», «Кадр», «На экране» идут подряд без пустых строк. */
function body(md: string, lid: string): string {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let table: string[][] | null = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    // Короткая первая колонка («#», «Сцена», «2–3») не должна переноситься по буквам.
    const narrow = table.every((r) => (r[0] ?? '').length <= 8);
    out.push(`<div class="tw"><table${narrow ? ' class="n1"' : ''}><thead><tr>` + (head ?? []).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
      + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
    table = null;
  };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.startsWith('|')) {
      closeList();
      if (/^\|[\s:|-]+\|$/.test(line)) continue;
      (table ??= []).push(line.split('|').slice(1, -1).map((c) => c.trim()));
      continue;
    }
    flushTable();
    if (!line.trim()) { closeList(); continue; }
    const h = /^(#{2,4})\s+(.+)$/.exec(line);
    if (h) {
      closeList();
      const level = (h[1] as string).length;
      const text = h[2] as string;
      if (level === 2) {
        const s = sectionOf(text);
        out.push(`<h2 class="sec ${s.cls}"><span>${esc(s.label)}</span></h2>` + (s.note ? `<p class="secnote">${esc(s.note)}</p>` : ''));
      } else if (/^Часть/.test(text)) {
        out.push(`<h3 class="part">${lid ? `<span class="lid">${lid}</span> ` : ''}${inline(text)}</h3>`);
      } else {
        out.push(`<h${level} class="scene">${lid ? `<span class="lid">${lid}</span> ` : ''}${inline(text)}</h${level}>`);
      }
      continue;
    }
    const li = /^\s*(?:([-*])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      const kind = li[1] ? 'ul' : 'ol';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(li[3] as string)}</li>`);
      continue;
    }
    closeList();
    if (/^>\s?/.test(line)) { out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    if (/^-{3,}$/.test(line)) { out.push('<hr>'); continue; }
    const cls = lineClass(line);
    out.push(`<p${cls ? ` class="${cls}"` : ''}>${inline(line)}</p>`);
  }
  flushTable();
  closeList();
  return out.join('\n');
}

interface Lesson { id: string; file: string; title: string; meta: string; duration: string; review: string; reviewed: boolean; md: string }

async function loadLesson(id: string, files: string[]): Promise<Lesson | undefined> {
  const file = files.find((f) => f.startsWith(`${id}-`));
  if (!file) return undefined;
  const md = await readFile(join(scriptsDir, file), 'utf8');
  const title = (/^#\s+(.+)$/m.exec(md)?.[1] ?? id).replace(new RegExp(`^${id}\\.?\\s*`), '');
  const meta = /^(Версии:.*|Версия:.*|Хронометраж:.*)$/m.exec(md)?.[1] ?? '';
  const duration = /Хронометраж:\s*([^·\n]+)/.exec(md)?.[1]?.trim() ?? '';
  const reviewFile = join(reviewsDir, `${id}.md`);
  let review = 'на проверке';
  let reviewed = false;
  if (existsSync(reviewFile)) {
    const verdict = /\*\*Итог:\*\*\s*([^\n]+)/.exec(await readFile(reviewFile, 'utf8'))?.[1]?.trim();
    review = `проверен${verdict ? `: ${verdict.replace(/\*+/g, '').replace(/[.。]$/, '')}` : ''}`;
    reviewed = true;
  }
  return { id, file, title, meta, duration, review, reviewed, md };
}

function audience(id: string): string {
  if (id.startsWith('CD')) return 'Только C, D и переподготовка B → C';
  if (id.startsWith('BC')) return 'Только переподготовка B → C';
  return 'Все категории: основной ролик — A, B, M; в конце — замены для C, D';
}

function lessonHtml(l: Lesson): string {
  const md = l.md.replace(/^#\s+.+\n/m, '').replace(/^(Версии:.*|Версия:.*)\n/m, '');
  return `<section class="lesson">
<header class="lh"><div class="lid-big">${l.id}</div><h1>${inline(l.title)}</h1>
<p class="meta">${inline(l.meta)}</p>
<p class="chips"><span class="chip aud">${esc(audience(l.id))}</span><span class="chip ${l.reviewed ? 'rv' : 'nrv'}">${esc(l.review)}</span></p></header>
${body(md, l.id)}
</section>`;
}

const LEGEND = `<div class="legend">
<h3>Как читать</h3>
<p class="voice"><strong>Голос:</strong> «…» — текст, который читает ведущая Ольга. Это и есть урок.</p>
<p class="shot ai"><strong>Кадр</strong> <span class="tag ai">ИИ-видео, 5 с</span> — нейросеть генерирует видео по этому описанию. Знаков, цифр и надписей в нём нет.</p>
<p class="shot scheme"><strong>Кадр</strong> <span class="tag scheme">Схема, 8 с</span> — анимированная схема, рисуем сами по раскадровке. Здесь точная геометрия: кто где стоит и куда едет.</p>
<p class="shot overlay"><strong>Кадр</strong> <span class="tag overlay">Наложение</span> — официальная картинка билета или знака поверх кадра.</p>
<p class="screen"><strong>На экране:</strong> — подписи, плашки и стрелки поверх видео.</p>
<p class="quiz"><strong>Вопрос:</strong> — ролик встаёт на паузу, ученик отвечает. ✅ стоит после правильного варианта. «Б28-6» — билет 28, вопрос 6.</p>
<p>Цветные полосы делят урок на разделы: <span class="mini main">сценарий ролика</span> <span class="mini cdv">замены для C, D</span> <span class="mini short">запоминалка</span> <span class="mini test">тест</span> <span class="mini tech">служебное</span></p>
</div>`;

const CSS = (running: string) => `
@page { size: A5; margin: 15mm 11mm 13mm 11mm;
  @top-left { content: "${running.replace(/"/g, '\\"')}"; font: 7pt "PT Sans", Helvetica, sans-serif; color: #8a909a; }
  @bottom-right { content: counter(page) " / " counter(pages); font: 7pt "PT Sans", Helvetica, sans-serif; color: #8a909a; } }
@page :first { @top-left { content: none; } }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 9.4pt/1.42 "PT Sans", "Helvetica Neue", Arial, sans-serif; color: #1d232b; background: #fff; }
h1, h2, h3, h4 { text-wrap: balance; break-after: avoid; }
p { margin: 0 0 4pt; orphans: 2; widows: 2; }
strong { font-weight: 700; }
code { font: 8pt Menlo, monospace; background: #f1f3f6; padding: 0 2px; border-radius: 2px; }
ul, ol { margin: 2pt 0 6pt; padding-left: 14pt; } li { margin: 0 0 2pt; }
blockquote { margin: 4pt 0; padding: 3pt 7pt; border-left: 2.5pt solid #c7ccd4; color: #4a525e; }
.cover { break-after: page; padding-top: 6mm; }
.brand { font-size: 8pt; letter-spacing: .08em; text-transform: uppercase; color: #b8322a; font-weight: 700; }
.cover h1 { font: 700 21pt/1.12 "PT Sans", Helvetica, sans-serif; margin: 6pt 0 4pt; }
.fileno { font-size: 9pt; color: #6b7380; }
.about { font-size: 10pt; color: #3b4350; margin: 6pt 0 10pt; }
.toc { width: 100%; border-collapse: collapse; font-size: 8.6pt; margin: 4pt 0 10pt; }
.toc td, .toc th { border-bottom: .5pt solid #dde1e7; padding: 3pt 3pt; text-align: left; vertical-align: top; }
.toc th { font-size: 7.4pt; color: #6b7380; font-weight: 400; text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; }
.toc .id { font-weight: 700; white-space: nowrap; }
.toc .rv { color: #1f6f3f; } .toc .nrv { color: #a0620a; }
.stamp { font-size: 7.6pt; color: #6b7380; margin-top: 8pt; }
.legend { border: .6pt solid #dde1e7; border-radius: 4pt; padding: 6pt 8pt 3pt; margin-top: 6pt; font-size: 8.4pt; }
.legend h3 { margin: 0 0 4pt; font-size: 9.5pt; }
.mini { display: inline-block; font-size: 7pt; padding: 0 4pt; border-radius: 2pt; color: #fff; margin: 1pt 1pt; }
.lesson { break-before: page; }
.lh { border-bottom: 1.2pt solid #1d232b; padding-bottom: 5pt; margin-bottom: 8pt; }
.lid-big { display: inline-block; font: 700 9pt "PT Sans", sans-serif; color: #fff; background: #b8322a; padding: 1.5pt 6pt; border-radius: 2.5pt; letter-spacing: .04em; }
.lh h1 { font: 700 16pt/1.15 "PT Sans", Helvetica, sans-serif; margin: 4pt 0 3pt; }
.meta { color: #4a525e; font-size: 8.4pt; }
.chips { margin: 3pt 0 0; } .chip { display: inline-block; font-size: 7.4pt; padding: 1pt 5pt; border-radius: 8pt; margin: 0 3pt 2pt 0; border: .6pt solid; }
.chip.aud { color: #1f4f86; border-color: #9fbbe0; background: #eef4fc; }
.chip.rv { color: #1f6f3f; border-color: #9ccfae; background: #edf8f1; }
.chip.nrv { color: #8a5200; border-color: #e6c48e; background: #fdf5e7; }
h2.sec { margin: 12pt 0 2pt; font-size: 9.6pt; letter-spacing: .02em; }
h2.sec span { display: block; padding: 3pt 7pt; border-radius: 2.5pt; color: #fff; background: #4a525e; }
.secnote { font-size: 7.8pt; color: #5b6370; margin: 0 0 6pt; }
.sec.main span, .mini.main { background: #1f7a46; } .sec.main.cd span { background: #c25e00; } .sec.main.bc span { background: #6b4bb5; }
.sec.cdv span, .mini.cdv { background: #d9822b; } .sec.bcv span { background: #8a6fd1; }
.sec.short span, .mini.short { background: #8a4fd8; } .sec.test span, .mini.test { background: #2b6cb0; }
.sec.tech span, .mini.tech { background: #8a909a; } .sec.goal span { background: #1f6b73; }
h3.scene, h4.scene { font-size: 10pt; margin: 11pt 0 4pt; padding-bottom: 1.5pt; border-bottom: .6pt solid #dde1e7; }
h4.scene { font-size: 9.6pt; }
h3.part { font-size: 11.5pt; margin: 14pt 0 5pt; color: #1f7a46; }
.lid { font-size: 6.8pt; font-weight: 700; color: #8a909a; border: .5pt solid #c7ccd4; border-radius: 2pt; padding: 0 2.5pt; vertical-align: 1.5pt; }
p.voice { background: #eff8f2; border-left: 2.6pt solid #1f7a46; padding: 3pt 6pt; border-radius: 0 2.5pt 2.5pt 0; break-inside: avoid; }
p.shot { font-size: 8.5pt; color: #39414d; border-left: 2.6pt solid #c7ccd4; padding: 1pt 6pt; break-inside: avoid; }
p.shot.ai { border-left-color: #8a4fd8; } p.shot.scheme { border-left-color: #2b6cb0; } p.shot.overlay { border-left-color: #d29a12; }
p.screen { font-size: 8.3pt; color: #4a525e; padding-left: 8.6pt; }
p.sound { font-size: 8.3pt; color: #4a525e; padding-left: 8.6pt; }
p.quiz { background: #fff6dd; border: .6pt solid #efcf75; padding: 3pt 6pt; border-radius: 2.5pt; break-inside: avoid; }
p.fb { font-size: 8.6pt; padding-left: 8.6pt; } p.fb.good { color: #1f6f3f; } p.fb.bad { color: #a3352b; }
.tag { font-size: 7pt; font-weight: 700; padding: 0 3pt; border-radius: 2pt; white-space: nowrap; }
.tag.ai { background: #efe6fb; color: #6a2fbf; } .tag.scheme { background: #e3eefb; color: #1f5a96; } .tag.overlay { background: #fcf0d2; color: #835a00; }
.tw { margin: 3pt 0 8pt; }
table { border-collapse: collapse; width: 100%; font-size: 7.6pt; line-height: 1.3; }
th, td { border: .5pt solid #d5dae1; padding: 2pt 3.5pt; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { background: #eef1f5; font-weight: 700; }
table.n1 td:first-child, table.n1 th:first-child { white-space: nowrap; width: 1%; }
tr { break-inside: avoid; }
hr { border: 0; border-top: .6pt solid #dde1e7; margin: 8pt 0; }
`;

function page(title: string, running: string, inner: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS(running)}</style></head><body>${inner}</body></html>`;
}

const stamp = () => {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}, ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

/** Chrome пишет PDF за секунды, но после этого может минутами не закрываться — ждём строку «bytes written» и завершаем сами. */
async function printPdf(html: string, pdf: string, work: string): Promise<void> {
  const htmlPath = join(work, `${Math.random().toString(36).slice(2)}.html`);
  await writeFile(htmlPath, html);
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--no-first-run',
    `--user-data-dir=${join(work, `profile-${Math.random().toString(36).slice(2)}`)}`, `--print-to-pdf=${pdf}`, pathToFileURL(htmlPath).href], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = () => { try { process.kill(-(chrome.pid as number), 'SIGKILL'); } catch { /* уже завершён */ } };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error(`Chrome не напечатал ${pdf} за 3 минуты`)); }, 180_000);
    const done = () => { clearTimeout(timer); stop(); resolve(); };
    const watch = (chunk: Buffer) => { if (/bytes written to file/.test(chunk.toString())) done(); };
    chrome.stdout.on('data', watch);
    chrome.stderr.on('data', watch);
    chrome.on('exit', () => { clearTimeout(timer); existsSync(pdf) ? resolve() : reject(new Error(`Chrome завершился без ${pdf}`)); });
  });
}

const files = (await readdir(scriptsDir)).filter((f) => f.endsWith('.md')).sort();
await mkdir(outDir, { recursive: true });
const work = await mkdtemp(join(tmpdir(), 'svetofor-pdf-'));
const when = stamp();
const made: { name: string; block: Block | null; lessons: Lesson[] }[] = [];

for (const b of BLOCKS) {
  const lessons = (await Promise.all(b.ids.map((id) => loadLesson(id, files)))).filter((x): x is Lesson => !!x);
  const toc = lessons.map((l) => `<tr><td class="id">${l.id}</td><td>${inline(l.title)}</td><td>${esc(l.duration)}</td><td class="${l.reviewed ? 'rv' : 'nrv'}">${l.reviewed ? 'проверен' : 'на проверке'}</td></tr>`).join('');
  const name = `${b.n} ${b.title.replace(/:/g, ",")} — ${b.ids[0]}–${b.ids[b.ids.length - 1]}`;
  const cover = `<div class="cover"><div class="brand">Автошкола «Светофор» · сценарии видеокурса</div>
<h1>${esc(b.title)}</h1><div class="fileno">Файл ${b.n} из ${BLOCKS.length} · уроки ${b.ids[0]}–${b.ids[b.ids.length - 1]}</div>
<p class="about">${esc(b.about)}</p>
<table class="toc"><tr><th>Урок</th><th>Название</th><th>Длит.</th><th>Проверка</th></tr>${toc}</table>
${LEGEND}
<p class="stamp">Версия от ${when}. ${lessons.every((l) => l.reviewed) ? 'Все уроки файла проверены; перед производством сценарии вычитывает инструктор.' : 'Уроки «на проверке» ещё дорабатываются; после проверки придут обновлённые файлы.'} Общая карта курса — в файле «00 Путеводитель».</p></div>`;
  const html = page(name, `Светофор · ${b.n} ${b.title}`, cover + lessons.map(lessonHtml).join('\n'));
  await printPdf(html, join(outDir, `${name}.pdf`), work);
  made.push({ name, block: b, lessons });
  console.log(`✓ ${name}.pdf (${lessons.length} ур.)`);
}

// 00 — путеводитель: кто что смотрит, что в каком файле, как читать.
const all = made.flatMap((m) => m.lessons);
const reviewedCount = all.filter((l) => l.reviewed).length;
const guide = `<div class="cover" style="break-after:auto"><div class="brand">Автошкола «Светофор» · сценарии видеокурса</div>
<h1>Путеводитель по сценариям</h1><div class="fileno">Файл 00 · версия от ${when}</div>
<p class="about">Здесь 49 сценариев роликов: 42 общих урока, 5 уроков отличий для грузовых и автобусов и 2 урока переподготовки. Сценарии разложены по ${BLOCKS.length} файлам, по темам. ${reviewedCount === all.length ? `Все ${all.length} уроков проверены по отдельности и курс целиком; спорные места для инструктора — в файле 14.` : `Проверено уроков: ${reviewedCount} из ${all.length}, остальные ещё проверяются.`}</p>
<h2 class="sec main"><span>Кто какие ролики смотрит</span></h2>
<table class="toc">
<tr><th>Ученик</th><th>Смотрит</th><th>Файлы</th></tr>
<tr><td class="id">B (A, M)</td><td>42 урока L00–L41, основной ролик каждого урока (легковые)</td><td>01–11</td></tr>
<tr><td class="id">C, D</td><td>Те же 42 урока в версии для грузовых (замены в конце каждого урока) и уроки отличий CD1–CD5</td><td>01–12</td></tr>
<tr><td class="id">B → C</td><td>Переподготовка: L00 (как устроен экзамен), BC0 (вход), CD1–CD5 (только то, что отличается), BC6 (итог)</td><td>01, 13, 12</td></tr>
</table>
<h2 class="sec plain"><span>Файлы</span></h2>
<table class="toc"><tr><th>Файл</th><th>Темы</th><th>Уроки</th></tr>
${made.map((m) => `<tr><td class="id">${m.block?.n}</td><td><strong>${esc(m.block?.title ?? '')}</strong><br>${esc(m.block?.about ?? '')}</td><td>${m.lessons.map((l) => l.id).join(', ')}</td></tr>`).join('')}
<tr><td class="id">14</td><td><strong>Спорные вопросы для инструктора</strong><br>Ошибки банка тренажёра, спорные официальные ответы, что сверить с действующим законом, решения по производству</td><td>—</td></tr>
</table>
<h2 class="sec goal"><span>Как устроен каждый урок</span></h2>
<ol>
<li><strong>Шапка</strong> — номер урока, название, длительность ролика, для кого он, статус проверки.</li>
<li><strong>Что ученик умеет после урока</strong> — цель.</li>
<li><strong>Покрытие билетов</strong> (служебное) — какие вопросы билетов урок объясняет. Каждый вопрос из 800 + 800 закреплён ровно за одним уроком.</li>
<li><strong>Сценарий ролика</strong> — по сценам с таймкодами. Внутри сцены по порядку идут голос, кадры, надписи на экране и вопросы в ролике.</li>
<li><strong>Версия для C, D</strong> — таблица замен по номерам сцен: другая машина в кадре, картинки из билетов CD, особенности грузовиков.</li>
<li><strong>Запоминалка</strong> — короткий вертикальный ролик для повторения.</li>
<li><strong>Тест после урока</strong> и <strong>Факты</strong> (служебное) — сверка с ПДД и спорные места.</li>
</ol>
${LEGEND}
<h2 class="sec plain"><span>Герои</span></h2>
<p><strong>Ольга</strong> — ведущая, инструктор автошколы. В кадре её нет, только голос. <strong>Тимур</strong>, 19 лет, учится на B: торопится и попадает в типичные ловушки, а Ольга разбирает его ошибки. <strong>Марина</strong>, 34 года, опытный водитель легковой: переучивается на грузовик, и привычки легковушки её подводят.</p>
</div>`;
await printPdf(page('00 Путеводитель по сценариям', 'Светофор · 00 Путеводитель', guide), join(outDir, '00 Путеводитель по сценариям.pdf'), work);
console.log('✓ 00 Путеводитель по сценариям.pdf');

// 14 — список спорных мест для инструктора (сводка отчётов проверки).
const listPath = join(reviewsDir, 'INSTRUCTOR-LIST.md');
if (existsSync(listPath)) {
  const listMd = await readFile(listPath, 'utf8');
  const listTitle = /^#\s+(.+)$/m.exec(listMd)?.[1] ?? 'Список для инструктора';
  const inner = `<div class="brand">Автошкола «Светофор» · сценарии видеокурса</div><h1 style="font:700 18pt/1.15 'PT Sans',sans-serif;margin:6pt 0 4pt">${esc(listTitle)}</h1>
<p class="fileno">Файл 14 · версия от ${when}</p>${body(listMd.replace(/^#\s+.+\n/m, ''), '')}`;
  await printPdf(page('14 Спорные вопросы для инструктора', 'Светофор · 14 Для инструктора', inner), join(outDir, '14 Спорные вопросы для инструктора.pdf'), work);
  console.log('✓ 14 Спорные вопросы для инструктора.pdf');
}
await rm(work, { recursive: true, force: true });
