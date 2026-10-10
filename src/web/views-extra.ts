import type { AccountService, StoredReport } from '../app/accounts.ts';
import type { TrainerService } from '../app/trainer.ts';
import type { StudyPlan } from '../core/plan.ts';
import type { QuestionBank } from '../core/question-bank.ts';
import { type FrequentMistake } from '../core/report.ts';
import type { SimilarQuestion } from '../core/similar.ts';
import { RULE_REF, type RuleIndex } from '../content/rules.ts';
import { TIPS, type Tip, tipsForTopic } from '../content/tips.ts';
import { type SafeHtml, clock, html, pct, plural, shortDate } from './dom.ts';
import { fmtDate } from './views-accounts.ts';

const T_FORMS = ['билет', 'билета', 'билетов'] as const;
const D_FORMS = ['день', 'дня', 'дней'] as const;

/** Секунды для показа времени на вопрос: «48 с», «1:20». */
export const secs = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)} с` : clock(ms));

// ---------- План подготовки ----------

export function planCard(plan: StudyPlan, examDate: string): SafeHtml {
  const status = {
    past: ['Экзамен уже прошёл', 'pill-medium', 'Укажите новую дату в настройках или уберите старую.'],
    done: ['Все билеты решены', 'pill-ready', 'Повторяйте ошибки и сдавайте пробные экзамены до самого дня сдачи.'],
    on_track: ['Успеваете', 'pill-good', `Держите темп: ${plan.perDay} ${plural(plan.perDay, T_FORMS)} в день.`],
    behind: ['Нужно ускориться', 'pill-low', `Чтобы пройти все билеты до экзамена, решайте по ${plan.perDay} ${plural(plan.perDay, T_FORMS)} в день. Сейчас в среднем ${plan.pace.toFixed(1)}.`],
  }[plan.status];
  return html`
    <section class="card plan">
      <div class="plan-head">
        <div><span class="label">Экзамен ${fmtDate(Math.floor(new Date(examDate).getTime() / 1000))}</span>
          <div class="plan-days">${plan.daysLeft < 0 ? 'прошёл' : plan.daysLeft === 0 ? 'сегодня' : html`${plan.daysLeft} ${plural(plan.daysLeft, D_FORMS)}`}</div></div>
        <span class="pill ${status[1]}">${status[0]}</span>
      </div>
      <p>${status[2]}</p>
      <div class="plan-facts">
        <span><b>${plan.unsolved}</b> не решено</span>
        <span><b>${plan.weak}</b> с ошибками</span>
        <span><b>${plan.pace.toFixed(1)}</b> ${plural(Math.round(plan.pace), T_FORMS)} в день за неделю</span>
      </div>
      ${plan.unsolved ? html`<div class="btn-row"><button class="btn btn-primary" data-action="start-next-ticket">Решить следующий билет</button></div>` : ''}
    </section>`;
}

// ---------- Похожие вопросы ----------

export function similarBlock(bank: QuestionBank, similar: readonly SimilarQuestion[]): SafeHtml | '' {
  if (!similar.length) return '';
  return html`
    <details class="similar">
      <summary>Похожие вопросы <span class="muted">(${similar.length})</span> — та же ситуация, другая формулировка</summary>
      <div class="similar-list">${similar.map(({ id }) => {
        const q = bank.get(id);
        const loc = bank.locate(id);
        return html`<article class="similar-item">
          ${q.image?.kind === 'url' ? html`<img src="${q.image.src}" alt="" loading="lazy" decoding="async">` : ''}
          <div class="similar-body">
            <span class="muted">${loc ? `Билет ${loc.ticket}, вопрос ${loc.position}` : ''}</span>
            <b>${q.text}</b>
            <ol class="similar-options">${q.options.map((o, i) => html`<li class="${i === q.correctIndex ? 'is-correct' : ''}">${o}</li>`)}</ol>
            <span class="muted similar-explain">${q.explanation}</span>
          </div>
        </article>`;
      })}</div>
    </details>`;
}

// ---------- Пункты ПДД ----------

/** Ссылки на пункты: открываемые — кнопки, прочие («Приложение 2») — текст. */
export function ruleRefs(refs: readonly string[] | undefined, rules: RuleIndex | undefined): SafeHtml | '' {
  if (!refs?.length) return '';
  return html`<span class="muted rule-refs">ПДД: ${refs.map((r, i) => html`${i ? ', ' : ''}${RULE_REF.test(r) && rules?.has(r)
    ? html`<button class="rule-link" data-action="rule" data-arg="${r}">п. ${r}</button>`
    : (/^\d/.test(r) ? `п. ${r}` : r)}`)}</span>`;
}

export function ruleDialog(num: string, rules: RuleIndex): SafeHtml {
  const hit = rules.find(num);
  return html`
    <div class="dialog-backdrop" data-action="rule-close"></div>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="rule-title">
      <div class="dialog-head"><span class="label">ПДД · раздел ${hit?.section.num ?? ''}. ${hit?.section.title ?? ''}</span>
        <button class="btn btn-ghost" data-action="rule-close" aria-label="Закрыть">✕</button></div>
      <h2 id="rule-title">Пункт ${hit?.item.num ?? num}</h2>
      ${hit ? html`<p class="rule-text">${hit.item.text}</p>` : html`<p class="muted">Текст пункта не найден.</p>`}
      <p class="muted note">${rules.book.edition}</p>
    </div>`;
}

export function rulesView(rules: RuleIndex | undefined, openSection: string): SafeHtml {
  if (!rules) {
    return html`<section class="card section"><h1>Правила дорожного движения</h1><p class="muted">Текст правил не загружен.</p></section>`;
  }
  return html`
    <section class="section"><h1>Правила дорожного движения</h1><p class="muted">${rules.book.edition}. Источник: ${rules.book.source}.</p></section>
    <div class="card topic-list">${rules.book.sections.map((s) => html`
      <details class="rule-section" ${s.num === openSection ? 'open' : ''}>
        <summary><b>${s.num}. ${s.title}</b><span class="muted"> · ${s.items.length} ${plural(s.items.length, ['пункт', 'пункта', 'пунктов'])}</span></summary>
        <div class="rule-items">${s.items.map((i) => html`<p class="rule-item" id="rule-${i.num}"><b class="mono">${i.num}.</b> ${i.text}</p>`)}</div>
      </details>`)}</div>`;
}

// ---------- Шпаргалки ----------

function tipCard(t: Tip, rules: RuleIndex | undefined): SafeHtml {
  return html`<article class="card tip">
    <h3>${t.title}</h3>
    ${t.lines.map((l) => (l.startsWith('— ') ? html`<p class="tip-li">${l.slice(2)}</p>` : html`<p>${l}</p>`))}
    ${ruleRefs(t.refs, rules)}
  </article>`;
}

export function tipsView(svc: TrainerService, rules: RuleIndex | undefined): SafeHtml {
  return html`
    <section class="section"><h1>Шпаргалки</h1><p class="muted">Короткие правила и приёмы запоминания по темам, на которых чаще всего ошибаются.</p></section>
    <div class="tips">${TIPS.map((t) => html`<div>
      ${tipCard(t, rules)}
      <div class="tip-actions"><button class="btn btn-ghost" data-action="start-topic" data-arg="${t.topicId}">Решать тему «${svc.bank.topicTitle(t.topicId)}» →</button></div>
    </div>`)}</div>`;
}

/** Подсказка перед темой: показывается один раз в начале тренировки по теме. */
export function topicTipBanner(topicId: string, rules: RuleIndex | undefined): SafeHtml | '' {
  const tips = tipsForTopic(topicId);
  if (!tips.length) return '';
  return html`<details class="tip-banner"><summary>Шпаргалка по теме</summary>${tips.map((t) => tipCard(t, rules))}</details>`;
}

// ---------- Отчёты ----------

export function studentReportCard(link: string | null): SafeHtml {
  return html`
    <section class="card section"><h2>Отчёт для автошколы</h2>
      <p class="muted">Отправьте управляющему ссылку с вашим прогрессом: решённые билеты, пробные экзамены, вероятность сдачи и ошибки. Он увидит, готовы ли вы к экзамену.</p>
      ${link ? html`<label class="field" for="report-link"><span>Ссылка-отчёт</span><input type="text" id="report-link" readonly value="${link}"></label>` : ''}
      <div class="btn-row">
        <button class="btn btn-primary" data-action="report-copy">Скопировать отчёт</button>
        <button class="btn" data-action="report-share">Отправить…</button>
      </div>
    </section>`;
}

export function reportsView(acc: AccountService, bank: QuestionBank, frequent: readonly FrequentMistake[], last: StoredReport | null, error: string | null): SafeHtml {
  const list = acc.reports();
  const readyLevel = (p: number) => (p >= 0.9 ? 'pill-ready' : p >= 0.7 ? 'pill-good' : p >= 0.3 ? 'pill-medium' : 'pill-low');
  return html`
    <section class="section"><h1>Отчёты учеников</h1>
      <p class="muted">Ученик отправляет ссылку-отчёт из раздела «Статистика». Личность подтверждена подписью автошколы; цифры — с устройства ученика.</p>
    </section>
    ${error ? html`<div class="notice" role="alert">${error}</div>` : ''}
    <form class="card section" id="report-form">
      <label class="field" for="report-text"><span>Вставьте ссылку-отчёт</span>
        <textarea id="report-text" name="report" rows="2" required autocomplete="off" spellcheck="false"></textarea></label>
      <div><button class="btn btn-primary" type="submit">Проверить и сохранить</button></div>
    </form>
    ${last ? html`<section class="card section issued-card" aria-live="polite"><h2>${last.name}</h2>${reportDetails(last)}</section>` : ''}
    <section class="section"><h2>Ученики <span class="muted">(${list.length})</span></h2>
      ${list.length ? html`<div class="card table-wrap"><table>
        <thead><tr><th>Ученик</th><th>Готовность</th><th>Билеты</th><th>Экзамены</th><th>Отчёт от</th></tr></thead>
        <tbody>${list.map((r) => html`<tr>
          <td>${r.name}</td>
          <td><span class="pill ${readyLevel(r.report.stats.probability)}">${pct(r.report.stats.probability)}</span></td>
          <td class="num">${r.report.stats.ticketsSolved}/${r.report.stats.ticketsTotal}</td>
          <td class="num">${r.report.stats.examsPassed}/${r.report.stats.examsTotal}</td>
          <td class="num">${shortDate(r.report.at)}</td></tr>`)}</tbody>
      </table></div>` : html`<p class="muted">Отчётов пока нет.</p>`}
    </section>
    <section class="section"><h2>Частые ошибки учеников</h2>
      ${frequent.length ? html`
        <p class="muted">Вопросы, на которых ошибаются двое и больше учеников. Чтобы все ученики видели их в режиме «Частые ошибки», скопируйте список и добавьте в файл <span class="mono">school/hard.json</span> репозитория.</p>
        <div class="btn-row"><button class="btn" data-action="copy-frequent">Скопировать список ID</button></div>
        <div class="card topic-list">${frequent.slice(0, 30).map((f) => {
          const q = bank.has(f.id) ? bank.get(f.id) : undefined;
          const loc = q ? bank.locate(f.id) : undefined;
          return html`<div class="topic"><span><b>${q?.text ?? f.id}</b><br><span class="topic-meta">${loc ? `Билет ${loc.ticket}, вопрос ${loc.position}` : ''}</span></span><span></span><span class="mono">${f.students} уч.</span></div>`;
        })}</div>` : html`<p class="muted">Появятся, когда придут отчёты хотя бы от двух учеников с одинаковыми ошибками.</p>`}
    </section>`;
}

function reportDetails(r: StoredReport): SafeHtml {
  const s = r.report.stats;
  return html`<div class="facts">
    <span class="fact"><span class="label">Вероятность сдачи</span><b>${pct(s.probability)}</b></span>
    <span class="fact"><span class="label">Билеты</span><b>${s.ticketsSolved}/${s.ticketsTotal}</b></span>
    <span class="fact"><span class="label">Без ошибок</span><b>${s.ticketsPerfect}</b></span>
    <span class="fact"><span class="label">Экзамены сданы</span><b>${s.examsPassed}/${s.examsTotal}</b></span>
    <span class="fact"><span class="label">Точность</span><b>${pct(s.accuracy)}</b></span>
    <span class="fact"><span class="label">Время на вопрос</span><b>${s.avgTimeMs ? secs(s.avgTimeMs) : '—'}</b></span>
    <span class="fact"><span class="label">Ошибок в работе</span><b>${s.mistakes.length}</b></span>
  </div><p class="muted">Комплект ${s.bank === 'AB' ? 'ABM' : 'CD'} · отчёт от ${shortDate(r.report.at)}</p>`;
}
