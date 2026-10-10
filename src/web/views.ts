import type { TrainerService } from '../app/trainer.ts';
import { type ExamState, FAIL_REASON_TEXT, remainingMs, summarizeExam } from '../core/exam.ts';
import type { QuestionBank } from '../core/question-bank.ts';
import { type PracticeState, type SessionItem, summarizePractice } from '../core/session.ts';
import type { ReadinessLevel, TicketStatus } from '../core/stats.ts';
import { dayKey } from '../core/progress.ts';
import { BLOCKS_PER_TICKET, type Question } from '../core/types.ts';
import { TICKET_SETS, UNCONFIRMED_CATEGORIES, ticketSet } from '../content/categories.ts';
import { type CatalogGroup, SIGNS, renderSign } from '../content/signs.ts';
import type { Identity } from '../core/credentials.ts';
import type { StudyPlan } from '../core/plan.ts';
import type { SimilarQuestion } from '../core/similar.ts';
import type { RuleIndex } from '../content/rules.ts';
import { logo, userChip } from './views-accounts.ts';
import { planCard, ruleRefs, secs, similarBlock, studentReportCard, topicTipBanner } from './views-extra.ts';
import { type SafeHtml, clock, html, pct, plural, raw, shortDate } from './dom.ts';

declare global {
  /** Подставляется сборщиком: в опубликованной версии браузер не даёт скачивать файлы. */
  var __PDD_ARTIFACT__: boolean | undefined;
}

export type Route = 'home' | 'tickets' | 'topics' | 'session' | 'result' | 'stats' | 'signs' | 'settings' | 'search' | 'admin'
  | 'rules' | 'tips' | 'reports';

/** Данные, которые экраны получают из приложения, а не из сервиса тренажёра. */
export interface ViewContext {
  readonly rules?: RuleIndex;
  readonly similar?: (id: string) => SimilarQuestion[];
  readonly plan?: StudyPlan;
  /** Частые ошибки учеников школы (school/hard.json), только id из текущего банка. */
  readonly frequent: readonly string[];
  readonly reportLink: string | null;
  readonly offline: { cached: number; total: number; busy: boolean } | null;
  readonly updateReady: boolean;
}

/** Выбранный, но ещё не подтверждённый вариант ответа (только в интерфейсе, до кнопки «Ответить»/«Далее»). */
export interface Selection {
  readonly sessionId: string;
  readonly itemIndex: number;
  readonly displayed: number;
}

export interface UiState {
  route: Route;
  selection: Selection | null;
  searchQuery: string;
  confirmReset: boolean;
  exportText: string;
  flash: { kind: 'ok' | 'bad'; text: string } | null;
}

const NAV: readonly { route: Route; title: string }[] = [
  { route: 'home', title: 'Главная' },
  { route: 'tickets', title: 'Билеты' },
  { route: 'topics', title: 'Темы' },
  { route: 'stats', title: 'Статистика' },
  { route: 'signs', title: 'Знаки' },
  { route: 'rules', title: 'Правила' },
  { route: 'tips', title: 'Шпаргалки' },
  { route: 'search', title: 'Поиск' },
  { route: 'settings', title: 'Настройки' },
];

const LEVEL_TEXT: Record<ReadinessLevel, string> = {
  low: 'Пока рано', medium: 'Есть пробелы', good: 'Почти готовы', ready: 'Готовы к экзамену',
};
const TICKET_TEXT: Record<TicketStatus, string> = {
  new: 'не решён', perfect: 'без ошибок', passed: 'сдан бы', failed: 'не сдан',
};
const Q_FORMS = ['вопрос', 'вопроса', 'вопросов'] as const;
const ERR_FORMS = ['ошибка', 'ошибки', 'ошибок'] as const;

/** Официальные изображения знаков по номеру (из справочника); без справочника — векторные схемы. */
const officialSigns = new Map<string, string>();
export function setSignCatalog(catalog: readonly CatalogGroup[] | undefined): void {
  officialSigns.clear();
  for (const g of catalog ?? []) for (const s of g.items) officialSigns.set(s.code, s.image);
}
const sign = (spec: string, size = 48) => {
  const img = spec.includes(':') ? undefined : officialSigns.get(spec);
  return img ? html`<img class="sign-img" src="${img}" alt="" width="${size}" height="${size}" loading="lazy">` : raw(renderSign(spec, size));
};
const meter = (value: number, tone = '') =>
  html`<div class="meter ${tone}" role="presentation"><span style="width:${Math.round(Math.max(0, Math.min(1, value)) * 100)}%"></span></div>`;

/** Шапка автошколы «Светофор»: логотип, комплект билетов, пользователь, разделы. */
export function brandHeader(inner: SafeHtml | '' = ''): SafeHtml {
  return html`
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="#home" aria-label="Автошкола «Светофор» — на главную">${logo(34)}
          <span class="brand-text"><span class="brand-name">Светофор</span><span class="brand-sub">автошкола</span></span></a>
        ${inner}
      </div>
    </header>`;
}

export function shell(svc: TrainerService, ui: UiState, body: SafeHtml, user: Identity | null = null): SafeHtml {
  const set = svc.ticketSet;
  const active: Route = ui.route === 'session' || ui.route === 'result' ? 'home' : ui.route;
  const staff = user?.role === 'admin' || user?.role === 'manager';
  const nav = staff ? [...NAV, { route: 'admin' as const, title: 'Управление' }, { route: 'reports' as const, title: 'Отчёты' }] : NAV;
  return html`
    ${brandHeader(html`
        <a class="cat-chip" href="#settings" title="Сменить комплект билетов">
          <span class="code">${set.code}</span><span class="chip-sub">${set.short}</span>
        </a>
        ${user ? userChip(user) : ''}
        <nav class="nav" aria-label="Разделы">
          ${nav.map((n) => html`<a href="#${n.route}" ${n.route === active ? raw('aria-current="page"') : ''}>${n.title}</a>`)}
        </nav>`)}
    <main id="main">
      ${svc.warnings.map((w) => html`<div class="notice">${w}</div>`)}
      ${ui.flash ? html`<div class="notice ${ui.flash.kind === 'ok' ? 'info' : ''}" role="status">${ui.flash.text}</div>` : ''}
      ${body}
    </main>`;
}

// ---------- Главная ----------

export function homeView(svc: TrainerService, user: Identity | null = null, ctx?: ViewContext): SafeHtml {
  const o = svc.overview();
  const r = o.readiness;
  const session = svc.session;
  const unfinished = session && (session.kind === 'exam' ? session.verdict === 'in_progress' : session.finishedAt === undefined);
  const solvedTickets = o.tickets.filter((t) => t.status !== 'new').length;
  const goal = Math.min(1, o.today / o.dailyGoal);

  const mode = (action: string, icon: string, title: string, meta: string, disabled = false) => html`
    <button class="mode" data-action="${action}" ${disabled ? raw('disabled') : ''}>
      ${sign(icon)}<span><span class="mode-title">${title}</span><br><span class="mode-meta">${meta}</span></span>
    </button>`;

  return html`
    ${user ? html`<section class="greeting"><h1>Здравствуйте${user.role === 'admin' ? '' : `, ${user.name}`}!</h1>
      <p class="muted">Тренажёр автошколы «Светофор» · билеты ${svc.ticketSet.code}</p></section>` : ''}
    ${svc.isDemoPack ? html`<div class="notice info"><span>Сейчас подключён <b>демо-банк</b>: ${svc.bankFor('AB').tickets.length} билета ABM и ${svc.bankFor('CD').tickets.length} билета CD.
      Полный официальный банк (по 40 билетов) подключается в <a href="#settings">настройках</a>.</span></div>` : ''}
    ${unfinished ? html`<div class="notice info"><span>У вас есть незавершённая тренировка «${session.kind === 'exam' ? 'Экзамен' : session.title}».</span>
      <a class="btn btn-primary" href="#session">Продолжить</a></div>` : ''}
    ${ctx?.updateReady ? html`<div class="notice info"><span>Доступна новая версия тренажёра.</span><button class="btn btn-primary" data-action="reload-app">Обновить</button></div>` : ''}
    ${ctx?.plan && svc.settings.examDate ? planCard(ctx.plan, svc.settings.examDate) : html`<div class="notice info"><span>Укажите <a href="#settings">дату экзамена</a> — тренажёр рассчитает, сколько билетов решать в день.</span></div>`}
    <section class="hero">
      <div class="card readiness">
        <span class="label">Вероятность сдать экзамен</span>
        <div class="readiness-top">
          <span class="big-num">${pct(r.probability)}</span>
          <span class="pill pill-${r.level}">${LEVEL_TEXT[r.level]}</span>
        </div>
        <div class="blocks">
          ${r.blocks.map((p, i) => html`<div class="block-bar"><span>Блок ${i + 1} · ${pct(p)}</span>${meter(p, p >= 0.9 ? 'good' : p < 0.6 ? 'bad' : '')}</div>`)}
        </div>
        <p class="muted" style="font-size:var(--step--1)">Расчёт по правилам ГИБДД: 4 блока по 5 вопросов, за ошибку +5 вопросов того же блока, не больше 2 ошибок.</p>
      </div>
      <div class="hero-side">
        <div class="card kpis">
          <div class="kpi"><span class="label">Сегодня</span><span class="kpi-value">${o.today}<span class="muted" style="font-size:var(--step-0)">/${o.dailyGoal}</span></span>${meter(goal, goal >= 1 ? 'good' : '')}</div>
          <div class="kpi"><span class="label">Серия</span><span class="kpi-value">${o.streak}</span><span class="muted" style="font-size:var(--step--1)">${plural(o.streak, ['день', 'дня', 'дней'])} подряд</span></div>
          <div class="kpi"><span class="label">Точность</span><span class="kpi-value">${o.bank.attempts ? pct(o.bank.accuracy) : '—'}</span><span class="muted" style="font-size:var(--step--1)">${o.bank.seen} из ${o.bank.total}</span></div>
        </div>
        <div class="cta">
          <button class="btn btn-primary" data-action="start-exam">Экзамен ГИБДД</button>
          <button class="btn" data-action="start-smart">Умная тренировка</button>
        </div>
      </div>
    </section>
    <section class="section">
      <div class="section-head"><h2>Режимы</h2><span class="muted">Билеты ${svc.ticketSet.code} · категории ${svc.ticketSet.categories.join(', ')}</span></div>
      <div class="modes">
        ${mode('go-tickets', '6.4', 'Билеты', `${solvedTickets} из ${o.tickets.length} решено`)}
        ${mode('start-exam', '2.5', 'Экзамен', `20 вопросов · 20 минут · ${o.exams.passed} из ${o.exams.total} сдано`)}
        ${mode('go-topics', '4.1.4', 'Темы', `${o.topics.length} ${plural(o.topics.length, ['тема', 'темы', 'тем'])}`)}
        ${mode('start-marathon', '5.1', 'Марафон', `все ${o.bank.total} ${plural(o.bank.total, Q_FORMS)} подряд`)}
        ${mode('start-smart', '1.8', 'Умная тренировка', 'слабые темы, новое и повторение')}
        ${mode('start-mistakes', '1.33', 'Работа над ошибками', `${o.bank.mistakes} ${plural(o.bank.mistakes, Q_FORMS)}`, o.bank.mistakes === 0)}
        ${mode('start-review', '4.3', 'Повторение', o.bank.due ? `${o.bank.due} к повторению` : 'на сегодня всё', o.bank.due === 0)}
        ${mode('start-hard', '1.17', 'Сложные вопросы', 'где вы ошибаетесь чаще', o.bank.mistakes === 0 && o.bank.attempts === o.bank.correct)}
        ${mode('start-favorites', '2.1', 'Избранное', `${o.bank.favorites} ${plural(o.bank.favorites, Q_FORMS)}`, o.bank.favorites === 0)}
        ${mode('start-slow', '3.24:?', 'Медленные вопросы', o.time.slow ? `${o.time.slow} ${plural(o.time.slow, Q_FORMS)} дольше 45 секунд` : 'где вы долго думаете', o.time.slow === 0)}
        ${ctx?.frequent.length ? mode('start-frequent', '1.33', 'Частые ошибки учеников', `${ctx.frequent.length} ${plural(ctx.frequent.length, Q_FORMS)} по данным автошколы`) : ''}
        ${mode('go-tips', '2.4', 'Шпаргалки', 'правила и запоминалки по темам')}
        ${mode('go-signs', '5.19.1', 'Дорожные знаки', 'справочник с изображениями')}
        ${mode('go-search', '3.24:?', 'Поиск', 'по тексту и пунктам ПДД')}
        ${mode('go-stats', '5.5', 'Статистика', `${o.bank.seen} из ${o.bank.total} изучено`)}
      </div>
    </section>`;
}

// ---------- Билеты и темы ----------

export function ticketsView(svc: TrainerService): SafeHtml {
  const tickets = svc.overview().tickets;
  return html`
    <section class="section">
      <div class="section-head"><div><h1>Билеты ${svc.ticketSet.code}</h1><p class="muted">Одни и те же для категорий ${svc.ticketSet.categories.join(', ')}</p></div>
        <div class="legend"><span><i class="sw-new"></i>не решён</span><span><i class="sw-perfect"></i>без ошибок</span><span><i class="sw-passed"></i>1–2 ошибки</span><span><i class="sw-failed"></i>3 и больше</span></div>
      </div>
      <div class="tickets">
        ${tickets.map((t) => html`
          <button class="ticket st-${t.status}" data-action="start-ticket" data-arg="${t.number}" aria-label="Билет ${t.number}: ${TICKET_TEXT[t.status]}">
            <span class="ticket-num">${t.number}</span>
            <span class="ticket-status">${t.status === 'new' ? 'не решён' : t.lastErrors === 0 ? 'без ошибок' : `${t.lastErrors} ${plural(t.lastErrors ?? 0, ERR_FORMS)}`}</span>
          </button>`)}
      </div>
    </section>`;
}

export function topicsView(svc: TrainerService): SafeHtml {
  const topics = svc.overview().topics;
  return html`
    <section class="section">
      <div class="section-head"><h1>Темы ПДД</h1><span class="muted">Освоение — доля верных ответов по теме</span></div>
      <div class="card topic-list">
        ${topics.map((t) => html`
          <button class="topic" data-action="start-topic" data-arg="${t.topicId}">
            <span><b>${t.title}</b><br><span class="topic-meta">${t.seen} из ${t.total} ${plural(t.total, Q_FORMS)} · выучено ${t.mastered}</span></span>
            ${meter(t.seen ? t.accuracy : 0, t.seen && t.accuracy >= 0.9 ? 'good' : t.seen && t.accuracy < 0.6 ? 'bad' : '')}
            <span class="mono">${t.seen ? pct(t.accuracy) : '—'}</span>
          </button>`)}
      </div>
    </section>`;
}

// ---------- Вопрос ----------

function questionImage(q: Question): SafeHtml | '' {
  if (!q.image) return '';
  if (q.image.kind === 'signs') return html`<div class="qimage">${q.image.signs.map((s) => sign(s, 120))}</div>`;
  return html`<div class="qimage photo"><img src="${q.image.src}" alt="${q.image.alt ?? 'Иллюстрация к вопросу'}" decoding="async"></div>`;
}

function cellClass(item: SessionItem, showCorrectness: boolean, current: boolean, extra: boolean): string {
  const cls = ['cell'];
  if (item.answer !== undefined) cls.push(showCorrectness ? (item.correct ? 'ok' : 'err') : 'done');
  if (extra) cls.push('extra');
  if (current) cls.push('current');
  return cls.join(' ');
}

function cellsView(session: PracticeState | ExamState, showCorrectness: boolean): SafeHtml {
  const cell = (item: SessionItem, i: number, extra = false) => html`
    <button class="${cellClass(item, showCorrectness, i === session.cursor, extra)}" data-action="goto" data-arg="${i}" aria-label="Вопрос ${i + 1}">${i + 1}</button>`;
  if (session.kind === 'exam' || session.mode === 'ticket') {
    const base = session.items.slice(0, 20);
    const groups = Array.from({ length: BLOCKS_PER_TICKET }, (_, b) => base.slice(b * 5, b * 5 + 5).map((it, k) => cell(it, b * 5 + k)));
    const extras = session.items.slice(20);
    return html`<div class="cells-scroll"><div class="cells">
      ${groups.map((g, b) => html`<div class="cell-group" role="group" aria-label="Блок ${b + 1}"><span class="cell-group-label">Б${b + 1}</span>${g}</div>`)}
      ${extras.length ? html`<div class="cell-group" role="group" aria-label="Дополнительные вопросы"><span class="cell-group-label">Доп</span>${extras.map((it, k) => cell(it, 20 + k, true))}</div>` : ''}
    </div></div>`;
  }
  // Длинные сессии (марафон): показываем окно из 20 ячеек вокруг текущего вопроса.
  const from = Math.max(0, Math.min(session.cursor - 10, session.items.length - 20));
  const windowItems = session.items.slice(from, from + 20);
  return html`<div class="cells-scroll"><div class="cells"><div class="cell-group">${windowItems.map((it, k) => cell(it, from + k))}</div></div></div>`;
}

/**
 * Экран вопроса. Нажатие на вариант только выбирает его (выбор можно сменить);
 * ответ фиксируется кнопкой на нижней панели: «Ответить» в тренировках с разбором, «Далее» на экзамене.
 */
export function sessionView(svc: TrainerService, now: number, selection: Selection | null = null, ctx?: ViewContext): SafeHtml {
  const s = svc.session;
  if (!s) {
    return html`<section class="card section"><h1>Нет активной тренировки</h1><p class="muted">Выберите режим на главной.</p><div><a class="btn btn-primary" href="#home">На главную</a></div></section>`;
  }
  const bank = svc.sessionBank;
  const item = s.items[s.cursor] as SessionItem;
  const q = bank.get(item.questionId);
  const isExam = s.kind === 'exam';
  const answered = item.answer !== undefined;
  const selected = !answered && selection?.sessionId === s.id && selection.itemIndex === s.cursor ? selection.displayed : undefined;
  const pending = selected !== undefined;
  // Подтверждение сразу переходит дальше на экзамене и в тренировке без мгновенного разбора.
  const confirmMovesOn = isExam || !svc.settings.instantFeedback;
  const reveal = answered && !isExam && svc.settings.instantFeedback;
  const fav = svc.progress.favorites.includes(q.id);
  const answeredCount = s.items.filter((i) => i.answer !== undefined).length;
  const loc = bank.locate(q.id);
  const finished = s.kind === 'practice' ? s.finishedAt !== undefined : s.verdict !== 'in_progress';
  const title = isExam ? 'Экзамен' : s.title;
  const extraInfo = isExam && (s.items[s.cursor] as { extra?: boolean }).extra ? html`<span class="pill pill-medium">дополнительный</span>` : '';

  return html`
    <section class="section ${answered || pending ? 'has-next' : ''}" aria-live="polite">
      <div class="session-head">
        <h1>${title}</h1>
        ${isExam ? html`<span class="timer ${remainingMs(s, now) < 120_000 ? 'low' : ''}" id="timer" aria-label="Осталось времени">${clock(remainingMs(s, now))}</span>` : ''}
        <span class="muted mono">${answeredCount}/${s.items.length}</span>
        <button class="btn btn-ghost" data-action="finish">${isExam ? 'Сдаться' : 'Завершить'}</button>
      </div>
      ${cellsView(s, !isExam && svc.settings.instantFeedback)}
      ${!isExam && s.kind === 'practice' && s.mode === 'topic' && s.topicId && answeredCount === 0 ? topicTipBanner(s.topicId, ctx?.rules) : ''}
      <article class="card qcard">
        <div class="qmeta">
          <span>Вопрос ${s.cursor + 1} из ${s.items.length}</span>
          ${isExam ? html`<span>· блок ${(s.items[s.cursor] as { block: number }).block}</span>` : ''}
          ${extraInfo}
          ${!isExam && s.kind === 'practice' && s.mode !== 'ticket' && loc ? html`<span>· билет ${loc.ticket}, вопрос ${loc.position}</span>` : ''}
          <span class="spacer"></span>
          <button class="btn btn-ghost star ${fav ? 'on' : ''}" data-action="favorite" data-arg="${q.id}" aria-pressed="${fav}" title="В избранное (F)">${fav ? '★' : '☆'}</button>
        </div>
        ${questionImage(q)}
        <p class="qtext">${q.text}</p>
        <div class="options" role="group" aria-label="Варианты ответа">
          ${item.optionOrder.map((orig, shown) => {
            const cls = ['option'];
            if (reveal && orig === q.correctIndex) cls.push('correct');
            else if (reveal && orig === item.answer) cls.push('wrong');
            else if (answered && orig === item.answer) cls.push('chosen');
            else if (shown === selected) cls.push('selected');
            return html`<button class="${cls.join(' ')}" data-action="select" data-arg="${shown}" aria-pressed="${shown === selected}" ${answered ? raw('disabled') : ''}>
              <span class="key">${shown + 1}</span><span>${q.options[orig]}</span></button>`;
          })}
        </div>
        ${reveal ? html`
          <div class="explain ${item.correct ? '' : 'bad'}">
            <span class="explain-title">${item.correct ? 'Верно' : `Неверно. Правильный ответ — ${item.optionOrder.indexOf(q.correctIndex) + 1}`}</span>
            <span>${q.explanation}</span>
            ${ruleRefs(q.ruleRefs, ctx?.rules)}
            ${item.timeMs !== undefined ? html`<span class="muted" style="font-size:var(--step--1)">Время на ответ: ${secs(item.timeMs)}${item.timeMs >= 45_000 ? ' — на экзамене это долго' : ''}</span>` : ''}
          </div>
          ${similarBlock(bank, ctx?.similar?.(q.id) ?? [])}` : ''}
        <div class="q-actions">
          <span class="grow kbd-hint">${answered ? '' : 'Выберите вариант — его можно сменить, пока не нажата кнопка внизу. '}Клавиши: <span class="kbd">1</span>–<span class="kbd">${item.optionOrder.length}</span> выбор, <span class="kbd">Enter</span> ${confirmMovesOn ? 'далее' : 'ответить'}${isExam ? html`, <span class="kbd">S</span> пропустить` : ''}</span>
          ${isExam && !answered ? html`<button class="btn" data-action="skip">Пропустить</button>` : ''}
        </div>
      </article>
      ${pending ? html`
        <div class="next-bar" role="region" aria-label="Подтверждение ответа">
          <div class="next-bar-inner">
            <span class="next-status">Выбран ответ ${(selected ?? 0) + 1}</span>
            <button class="btn btn-primary" id="next-btn" data-action="confirm">${confirmMovesOn ? html`Далее <span aria-hidden="true">→</span>` : 'Ответить'}</button>
          </div>
        </div>` : ''}
      ${answered ? html`
        <div class="next-bar" role="region" aria-label="Следующий вопрос">
          <div class="next-bar-inner">
            <span class="next-status ${reveal ? (item.correct ? 'ok' : 'bad') : ''}">${reveal ? (item.correct ? 'Верно' : 'Неверно') : 'Ответ принят'}</span>
            ${finished && !isExam
              ? html`<button class="btn btn-primary" id="next-btn" data-action="to-result">Результаты</button>`
              : html`<button class="btn btn-primary" id="next-btn" data-action="next">Далее <span aria-hidden="true">→</span></button>`}
          </div>
        </div>` : ''}
    </section>`;
}

// ---------- Результаты ----------

function reviewList(bank: QuestionBank, items: readonly SessionItem[]): SafeHtml {
  const wrong = items.filter((i) => i.correct === false);
  if (!wrong.length) return html`<p class="muted">Ошибок нет.</p>`;
  return html`<div class="review">${wrong.map((it) => {
    const q = bank.get(it.questionId);
    return html`<article class="card review-item">
      ${questionImage(q)}
      <b>${q.text}</b>
      <span class="ans ans-bad">Ваш ответ: ${q.options[it.answer ?? -1] ?? '—'}</span>
      <span class="ans ans-good">Правильно: ${q.options[q.correctIndex]}</span>
      <span class="muted">${q.explanation}</span>
    </article>`;
  })}</div>`;
}

export function resultView(svc: TrainerService, now: number): SafeHtml {
  const s = svc.session;
  if (!s) return sessionView(svc, now);
  const bank = svc.sessionBank;
  if (s.kind === 'exam') {
    const sum = summarizeExam(s, now);
    const pass = sum.verdict === 'passed';
    return html`
      <section class="card verdict ${pass ? 'pass' : 'fail'}">
        <span class="label">Экзамен ГИБДД · билеты ${ticketSet(s.bankId).code}</span>
        <span class="verdict-word">${pass ? 'СДАН' : 'НЕ СДАН'}</span>
        ${sum.failReason ? html`<span>${FAIL_REASON_TEXT[sum.failReason]}</span>` : html`<span>${sum.errors ? 'Ошибки исправлены дополнительными вопросами' : 'Без единой ошибки'}</span>`}
        <div class="facts">
          <span class="fact"><span class="label">Время</span><b>${clock(sum.durationMs)}</b></span>
          <span class="fact"><span class="label">Вопросов</span><b>${sum.answered}/${sum.total}</b></span>
          <span class="fact"><span class="label">Ошибок</span><b>${sum.errors}</b></span>
          <span class="fact"><span class="label">Доп. вопросов</span><b>${sum.extraQuestions}</b></span>
          ${sum.avgTimeMs ? html`<span class="fact"><span class="label">На вопрос</span><b>${secs(sum.avgTimeMs)}</b></span>` : ''}
        </div>
      </section>
      <section class="section"><h2>Блоки</h2>
        <div class="blocks">${sum.blocks.map((b) => html`<div class="card block-bar"><b>Блок ${b.block}</b><span>${b.errors ? `${b.errors} ${plural(b.errors, ERR_FORMS)}` : 'без ошибок'}${b.extended ? ' · +5 вопросов' : ''}</span></div>`)}</div>
      </section>
      <div class="btn-row"><button class="btn btn-primary" data-action="start-exam">Новый экзамен</button>${sum.errors ? html`<button class="btn" data-action="start-mistakes">Разобрать ошибки</button>` : ''}<a class="btn" href="#home">На главную</a></div>
      <section class="section"><h2>Разбор ошибок</h2>${reviewList(bank, s.items)}</section>`;
  }
  const sum = summarizePractice(s, now);
  const ok = sum.answered > 0 && sum.wrong === 0;
  return html`
    <section class="card verdict ${ok ? 'pass' : sum.wrong > 2 ? 'fail' : ''}">
      <span class="label">${s.title}</span>
      <span class="verdict-word">${sum.correct} из ${sum.total}</span>
      <span>${sum.answered < sum.total ? `Отвечено ${sum.answered} из ${sum.total}. ` : ''}${sum.wrong ? `${sum.wrong} ${plural(sum.wrong, ERR_FORMS)} — вопросы добавлены в «Работу над ошибками»` : 'Без ошибок'}</span>
      <div class="facts"><span class="fact"><span class="label">Время</span><b>${clock(sum.durationMs)}</b></span>${sum.avgTimeMs ? html`<span class="fact"><span class="label">На вопрос</span><b>${secs(sum.avgTimeMs)}</b></span>` : ''}</div>
    </section>
    <div class="btn-row">
      ${s.mode === 'ticket' && s.ticketNumber !== undefined ? html`<button class="btn btn-primary" data-action="start-ticket" data-arg="${s.ticketNumber}">Решить ещё раз</button>
        ${bank.tickets.some((t) => t.number === (s.ticketNumber ?? 0) + 1) ? html`<button class="btn" data-action="start-ticket" data-arg="${(s.ticketNumber ?? 0) + 1}">Следующий билет</button>` : ''}` : ''}
      ${sum.wrong ? html`<button class="btn" data-action="start-mistakes">Работа над ошибками</button>` : ''}
      <a class="btn" href="#home">На главную</a>
    </div>
    <section class="section"><h2>Разбор ошибок</h2>${reviewList(bank, s.items)}</section>`;
}

// ---------- Статистика ----------

export function statsView(svc: TrainerService, now: number, ctx?: ViewContext): SafeHtml {
  const o = svc.overview();
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(now);
    const ts = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (13 - i), 12).getTime();
    return { label: String(new Date(ts).getDate()), value: svc.progress.activity[dayKey(ts)] ?? 0 };
  });
  const max = Math.max(10, ...days.map((d) => d.value));
  const weakest = [...o.topics].filter((t) => t.seen > 0).sort((a, b) => a.accuracy - b.accuracy).slice(0, 5);
  return html`
    <section class="section"><h1>Статистика · билеты ${svc.ticketSet.code}</h1>
      <div class="stat-grid">
        <div class="card kpi"><span class="label">Вероятность сдачи</span><span class="kpi-value">${pct(o.readiness.probability)}</span></div>
        <div class="card kpi"><span class="label">Изучено вопросов</span><span class="kpi-value">${o.bank.seen}/${o.bank.total}</span></div>
        <div class="card kpi"><span class="label">Выучено</span><span class="kpi-value">${o.bank.mastered}</span></div>
        <div class="card kpi"><span class="label">Точность</span><span class="kpi-value">${o.bank.attempts ? pct(o.bank.accuracy) : '—'}</span></div>
        <div class="card kpi"><span class="label">Экзамены</span><span class="kpi-value">${o.exams.passed}/${o.exams.total}</span></div>
        <div class="card kpi"><span class="label">Серия</span><span class="kpi-value">${o.streak} ${plural(o.streak, ['день', 'дня', 'дней'])}</span></div>
        <div class="card kpi"><span class="label">Время на вопрос</span><span class="kpi-value">${o.time.avgMs ? secs(o.time.avgMs) : '—'}</span><span class="muted" style="font-size:var(--step--1)">${o.time.slow ? `медленных: ${o.time.slow}` : 'на экзамене — минута'}</span></div>
      </div>
    </section>
    ${ctx?.reportLink !== undefined && ctx.reportLink !== null ? studentReportCard(ctx.reportLink || null) : ''}
    <section class="card section"><div class="section-head"><h2>Ответы за 14 дней</h2><span class="muted">цель — ${o.dailyGoal} в день</span></div>
      <div class="bars" role="img" aria-label="Количество ответов по дням">${days.map((d) => html`<div title="${d.value} ответов"><span style="height:${Math.round((d.value / max) * 100)}%"></span></div>`)}</div>
      <div class="bars-x">${days.map((d) => html`<span>${d.label}</span>`)}</div>
    </section>
    <section class="section"><h2>Слабые темы</h2>
      ${weakest.length ? html`<div class="card topic-list">${weakest.map((t) => html`
        <button class="topic" data-action="start-topic" data-arg="${t.topicId}"><span><b>${t.title}</b><br><span class="topic-meta">${t.seen} из ${t.total} изучено</span></span>${meter(t.accuracy, t.accuracy < 0.6 ? 'bad' : '')}<span class="mono">${pct(t.accuracy)}</span></button>`)}</div>`
        : html`<p class="muted">Решите несколько вопросов, и здесь появятся темы, требующие внимания.</p>`}
    </section>
    <section class="section"><h2>История экзаменов</h2>
      ${o.recentExams.length ? html`<div class="card table-wrap"><table>
        <thead><tr><th>Дата</th><th>Результат</th><th>Ошибок</th><th>Вопросов</th><th>Время</th></tr></thead>
        <tbody>${o.recentExams.map((e) => html`<tr><td>${shortDate(e.finishedAt)}</td>
          <td><span class="pill ${e.passed ? 'pill-good' : 'pill-low'}">${e.passed ? 'сдан' : 'не сдан'}</span></td>
          <td class="num">${e.errors}</td><td class="num">${e.total}</td><td class="num mono">${clock(e.finishedAt - e.startedAt)}</td></tr>`)}</tbody>
      </table></div>` : html`<p class="muted">Экзаменов пока не было.</p>`}
    </section>`;
}

// ---------- Знаки, поиск ----------

export function signsView(catalog?: readonly CatalogGroup[]): SafeHtml {
  if (catalog?.length) {
    return html`
      <section class="section"><h1>Дорожные знаки</h1><p class="muted">Изображения и описания из официального набора экзаменационных материалов.</p></section>
      ${catalog.map((g) => html`<section class="section"><h2>${g.group}</h2><div class="sign-grid">
        ${g.items.map((s) => html`<div class="card sign-card">
          <img src="${s.image}" alt="Знак ${s.code} «${s.title}»" loading="lazy" decoding="async" width="84" height="84">
          <span class="sign-code">${s.code}</span><span>${s.title}</span>
          ${s.description ? html`<details><summary>Описание</summary><p>${s.description}</p></details>` : ''}
        </div>`)}
      </div></section>`)}`;
  }
  const groups = [...new Set(SIGNS.map((s) => s.group))];
  return html`
    <section class="section"><h1>Дорожные знаки</h1><p class="muted">Схематичные изображения: официальный справочник загружается вместе с полным банком билетов.</p></section>
    ${groups.map((g) => html`<section class="section"><h2>${g}</h2><div class="sign-grid">
      ${SIGNS.filter((s) => s.group === g).map((s) => html`<div class="card sign-card">${sign(s.code + (s.defaultValue ? `:${s.defaultValue}` : ''), 84)}<span class="sign-code">${s.code}</span><span>${s.title}</span></div>`)}
    </div></section>`)}`;
}

export function searchView(svc: TrainerService, ui: UiState): SafeHtml {
  const results = ui.searchQuery ? svc.bank.search(ui.searchQuery, 30) : [];
  return html`
    <section class="section"><h1>Поиск по вопросам</h1>
      <form class="search-form" id="search-form" role="search">
        <input type="search" id="search-input" name="q" value="${ui.searchQuery}" placeholder="Например: обгон, 50 м, шлагбаум, 12.4" aria-label="Поисковый запрос">
        <button class="btn btn-primary" type="submit">Найти</button>
      </form>
      ${ui.searchQuery ? html`<p class="muted">Найдено: ${results.length}</p>` : ''}
      ${results.length > 1 ? html`<div><button class="btn" data-action="start-search">Решить все найденные</button></div>` : ''}
      <div class="card topic-list">${results.map((id) => {
        const q = svc.bank.get(id);
        const loc = svc.bank.locate(id);
        return html`<button class="topic" data-action="start-question" data-arg="${id}"><span><b>${q.text}</b><br><span class="topic-meta">Билет ${loc?.ticket}, вопрос ${loc?.position}</span></span><span></span><span class="mono">→</span></button>`;
      })}</div>
    </section>`;
}

// ---------- Настройки ----------

export function settingsView(svc: TrainerService, ui: UiState, ctx?: ViewContext): SafeHtml {
  const st = svc.settings;
  const toggle = (key: 'instantFeedback' | 'shuffleOptions' | 'examFailFast', title: string, hint: string) => html`
    <label class="form-row" for="set-${key}"><div><b>${title}</b><br><span class="muted">${hint}</span></div>
      <input class="switch" type="checkbox" id="set-${key}" data-setting="${key}" ${st[key] ? raw('checked') : ''}></label>`;
  return html`
    <section class="section"><h1>Комплект билетов</h1>
      <p class="muted">В ГИБДД всего два комплекта билетов. Все категории внутри комплекта сдают одни и те же вопросы:
        если вы получаете A и B одновременно, учить нужно один комплект ABM.</p>
      <div class="set-grid">${TICKET_SETS.map((t) => html`
        <button class="set-option" data-action="set-bank" data-arg="${t.bank}" aria-pressed="${t.bank === st.bank}">
          <span class="set-code">${t.code}</span>
          <span class="set-body"><b>${t.vehicles}</b>
            <span class="chips" aria-label="Категории">${t.categories.map((c) => html`<span class="chip">${c}</span>`)}</span>
          </span>
        </button>`)}
      </div>
      <p class="muted note">Комплекты совпадают примерно на три четверти, в CD больше вопросов о грузовых автомобилях, автобусах и маршрутном транспорте.
        Для ${UNCONFIRMED_CATEGORIES.join(', ')} теоретический экзамен тоже обязателен, но по какому комплекту он проходит, в открытых правилах не указано: уточните в автошколе.</p>
    </section>
    <section class="card section"><h2>Тренировка</h2>
      <div>
        ${toggle('instantFeedback', 'Показывать ответ сразу', 'Правильный ответ и пояснение после каждого вопроса (кроме экзамена)')}
        ${toggle('shuffleOptions', 'Перемешивать варианты', 'В тренировках, кроме билетов: проверяет знание, а не память о позиции ответа')}
        ${toggle('examFailFast', 'Строгий экзамен', 'Экзамен завершается сразу при провале, как в ГИБДД')}
        <label class="form-row" for="set-goal"><div><b>Дневная цель</b><br><span class="muted">Сколько вопросов решать в день</span></div>
          <select id="set-goal" data-setting="dailyGoal">${[20, 40, 60, 100, 200].map((n) => html`<option value="${n}" ${n === st.dailyGoal ? raw('selected') : ''}>${n}</option>`)}</select></label>
        <label class="form-row" for="set-exam-date"><div><b>Дата экзамена</b><br><span class="muted">План подготовки на главной: сколько билетов решать в день</span></div>
          <input type="date" id="set-exam-date" data-setting="examDate" value="${st.examDate ?? ''}"></label>
        <label class="form-row" for="set-theme"><div><b>Тема оформления</b></div>
          <select id="set-theme" data-setting="theme">${(['auto', 'light', 'dark'] as const).map((t) => html`<option value="${t}" ${t === st.theme ? raw('selected') : ''}>${{ auto: 'как в системе', light: 'светлая', dark: 'тёмная' }[t]}</option>`)}</select></label>
      </div>
    </section>
    ${ctx?.offline ? html`<section class="card section"><h2>Без интернета</h2>
      <p class="muted">Тренажёр открывается без сети, если его уже открывали. Картинки к вопросам подгружаются по мере решения; чтобы заниматься в дороге, скачайте их заранее (около 21 МБ).</p>
      <p>Скачано картинок: <b>${ctx.offline.cached}</b> из ${ctx.offline.total}</p>
      <div class="btn-row"><button class="btn btn-primary" data-action="offline-download" ${ctx.offline.busy || ctx.offline.cached >= ctx.offline.total ? 'disabled' : ''}>${ctx.offline.busy ? 'Скачиваем…' : ctx.offline.cached >= ctx.offline.total ? 'Всё скачано' : 'Скачать все картинки'}</button></div>
    </section>` : ''}
    <section class="card section"><h2>Банк вопросов</h2>
      <p>Сейчас: <b>${svc.pack.title}</b> <span class="muted">(версия ${svc.pack.version}, ${svc.pack.questions.length} ${plural(svc.pack.questions.length, Q_FORMS)})</span></p>
      <p class="muted">Полный официальный банк собирается командой <span class="mono">npm run import:bank</span> из открытого набора билетов и загружается сюда JSON-файлом.</p>
      <div class="btn-row">
        <label class="btn" for="pack-file">Загрузить банк (JSON)</label><input type="file" id="pack-file" accept="application/json,.json" hidden>
        ${svc.isCustomPack ? html`<button class="btn" data-action="reset-pack">Вернуть демо-банк</button>` : ''}
      </div>
    </section>
    <section class="card section"><h2>Мои данные</h2>
      <p class="muted">Прогресс хранится на этом устройстве. Экспорт и импорт переносят его на другое устройство; при импорте данные объединяются, ничего не теряется.</p>
      <div class="btn-row">
        <button class="btn" data-action="export">Показать экспорт</button>
        <label class="btn" for="import-file">Импорт из файла</label><input type="file" id="import-file" accept="application/json,.json" hidden>
        ${ui.confirmReset
          ? html`<button class="btn btn-danger" data-action="reset-confirm">Да, удалить весь прогресс</button><button class="btn" data-action="reset-cancel">Отмена</button>`
          : html`<button class="btn btn-danger" data-action="reset-ask">Сбросить прогресс</button>`}
      </div>
      ${ui.exportText ? html`<textarea id="export-text" readonly aria-label="Данные для экспорта">${ui.exportText}</textarea>
        <div class="btn-row"><button class="btn" data-action="copy-export">Скопировать</button>${globalThis.__PDD_ARTIFACT__ ? '' : html`<a class="btn" id="export-download" download="pdd-progress.json" href="data:application/json;charset=utf-8,${encodeURIComponent(ui.exportText)}">Скачать файл</a>`}</div>` : ''}
    </section>`;
}
