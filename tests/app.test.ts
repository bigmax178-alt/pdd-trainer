import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TrainerService } from '../src/app/trainer.ts';
import type { ExamState } from '../src/core/exam.ts';
import { DomainError } from '../src/core/types.ts';
import { DEMO_PACK } from '../src/content/demo-bank.ts';
import { MemoryStore } from '../src/infra/stores.ts';
import { escapeHtml, html, plural, raw } from '../src/web/dom.ts';
import {
  type UiState, homeView, resultView, searchView, sessionView, settingsView, shell, signsView, statsView,
  ticketsView, topicsView,
} from '../src/web/views.ts';
import { FakeClock, MIN, right, wrong } from './fixtures.ts';

function setup(store = new MemoryStore(), clock = new FakeClock()) {
  let n = 0;
  const svc = new TrainerService({ store, clock, seed: () => 12345, newId: () => `id-${++n}` });
  return { svc, store, clock };
}

const answerCurrent = (svc: TrainerService, ok: boolean) => {
  const s = svc.session!;
  return svc.answer(ok ? right(s, svc.sessionBank) : wrong(s, svc.sessionBank));
};

describe('Сервис тренажёра', () => {
  it('билет: решение подряд записывает результат и ошибки', () => {
    const { svc } = setup();
    svc.startTicket(1);
    for (let i = 0; i < 20; i++) {
      answerCurrent(svc, i >= 2);
      svc.advance();
    }
    assert.ok(svc.session?.kind === 'practice' && svc.session.finishedAt !== undefined);
    assert.equal(svc.progress.tickets['AB:1']?.lastErrors, 2);
    assert.equal(svc.progress.mistakes.length, 2);
    assert.equal(svc.overview().tickets[0]?.status, 'passed');
    svc.startMistakes();
    assert.equal(svc.session?.items.length, 2);
  });

  it('экзамен через сервис: ошибка добавляет вопросы, итог пишется в историю', () => {
    const { svc } = setup();
    svc.startExam();
    const out = answerCurrent(svc, false);
    assert.ok(out && 'addedQuestions' in out && out.addedQuestions === 5);
    while ((svc.session as ExamState).verdict === 'in_progress') {
      svc.advance();
      answerCurrent(svc, true);
    }
    assert.equal((svc.session as ExamState).verdict, 'passed');
    assert.equal(svc.progress.exams.length, 1);
    assert.equal(svc.overview().exams.passed, 1);
  });

  it('после ответа остаёмся на вопросе до «Далее» — и в тренировке, и на экзамене', () => {
    const { svc } = setup();
    svc.startExam();
    answerCurrent(svc, true);
    assert.equal(svc.session?.cursor, 0, 'экзамен не перескакивает сам');
    assert.notEqual(svc.session?.items[0]?.answer, undefined);
    svc.advance();
    assert.equal(svc.session?.cursor, 1);
    svc.updateSettings({ instantFeedback: false });
    svc.startTicket(1);
    answerCurrent(svc, false);
    assert.equal(svc.session?.cursor, 0, 'и без мгновенного разбора автоперехода нет');
    svc.advance();
    assert.equal(svc.session?.cursor, 1);
  });

  it('таймер: по истечении времени экзамен не сдан и записан', () => {
    const { svc, clock } = setup();
    svc.startExam();
    clock.advance(19 * MIN);
    assert.equal(svc.tick(), false);
    clock.advance(2 * MIN);
    assert.equal(svc.tick(), true);
    assert.equal((svc.session as ExamState).failReason, 'timeout');
    assert.equal(svc.progress.exams[0]?.passed, false);
  });

  it('комплект CD: билеты грузовых и автобусов', () => {
    const { svc } = setup();
    svc.updateSettings({ bank: 'CD' });
    assert.equal(svc.bank.id, 'CD');
    assert.deepEqual(svc.ticketSet.categories, ['C', 'D', 'C1', 'D1']);
    svc.startTicket(2);
    assert.ok(svc.session?.items.some((i) => i.questionId.startsWith('cd2')));
  });

  it('состояние переживает перезагрузку; повреждённые данные не роняют приложение', () => {
    const { svc, store, clock } = setup();
    svc.startMarathon();
    answerCurrent(svc, false);
    svc.toggleFavorite('ab1-01');
    const again = new TrainerService({ store, clock });
    assert.equal(again.session?.items.length, svc.session?.items.length);
    assert.deepEqual(again.progress, svc.progress);

    store.set('pdd.v1.progress', '{не json');
    store.set('pdd.v1.settings', JSON.stringify({ category: 'Z', dailyGoal: -5, theme: 'neon' }));
    const broken = new TrainerService({ store, clock });
    assert.equal(broken.settings.bank, 'AB');
    assert.equal(broken.settings.dailyGoal, 40);
    assert.ok(broken.warnings.length > 0);
    assert.equal(Object.keys(broken.progress.questions).length, 0);
  });

  it('старые настройки с категорией переводятся в комплект билетов', () => {
    const store = new MemoryStore();
    store.set('pdd.v1.settings', JSON.stringify({ category: 'D1' }));
    assert.equal(setup(store).svc.settings.bank, 'CD');
    store.set('pdd.v1.settings', JSON.stringify({ category: 'A' }));
    assert.equal(setup(store).svc.settings.bank, 'AB');
  });

  it('экспорт → импорт на другом устройстве объединяет прогресс', () => {
    const a = setup();
    a.svc.startTicket(1);
    answerCurrent(a.svc, true);
    const b = setup();
    b.svc.startTicket(2);
    answerCurrent(b.svc, false);
    b.svc.importData(a.svc.exportData());
    assert.equal(Object.keys(b.svc.progress.questions).length, 2);
    assert.throws(() => b.svc.importData('нет'), /JSON/);
  });

  it('пустые режимы сообщают понятную причину', () => {
    const { svc } = setup();
    assert.throws(() => svc.startMistakes(), (e: DomainError) => /Ошибок пока нет/.test(e.message));
    assert.throws(() => svc.startFavorites(), DomainError);
    assert.throws(() => svc.answer(0), DomainError);
  });

  it('загрузка своего банка: невалидный отклоняется, валидный применяется', () => {
    const { svc } = setup();
    assert.throws(() => svc.loadCustomPack('{"questions":[],"banks":{}}'));
    assert.equal(svc.isCustomPack, false);
    const custom = { ...DEMO_PACK, version: 'custom-1', title: 'Мой банк' };
    svc.loadCustomPack(JSON.stringify(custom));
    assert.equal(svc.pack.version, 'custom-1');
    svc.resetPack();
    assert.equal(svc.isCustomPack, false);
  });
});

describe('Веб-представления (рендер без браузера)', () => {
  const ui = (route: UiState['route']): UiState => ({ route, searchQuery: 'обгон', confirmReset: true, exportText: '{"a":1}', flash: null });

  it('html-шаблон экранирует данные; plural склоняет', () => {
    assert.equal(html`<b>${'<img onerror=x>'}</b>`.value, '<b>&lt;img onerror=x&gt;</b>');
    assert.equal(html`${raw('<i>')}${['a', '&']}`.value, '<i>a&amp;');
    assert.equal(escapeHtml(`"'`), '&quot;&#39;');
    assert.deepEqual([1, 2, 5, 11, 21, 104].map((n) => plural(n, ['вопрос', 'вопроса', 'вопросов'])),
      ['вопрос', 'вопроса', 'вопросов', 'вопросов', 'вопрос', 'вопроса']);
  });

  it('все экраны рендерятся во всех состояниях', () => {
    const { svc, clock } = setup();
    const now = clock.now();
    for (const v of [homeView(svc), ticketsView(svc), topicsView(svc), statsView(svc, now), signsView(),
      searchView(svc, ui('search')), settingsView(svc, ui('settings')), sessionView(svc, now)]) {
      assert.ok(shell(svc, ui('home'), v).value.length > 200);
    }
    svc.startExam();
    answerCurrent(svc, false);
    assert.match(sessionView(svc, now).value, /Доп/);
    svc.finish();
    assert.match(resultView(svc, now).value, /НЕ СДАН/);
    svc.startTicket(1);
    answerCurrent(svc, false);
    assert.match(sessionView(svc, now).value, /Правильный ответ/);
  });

  it('контент из загруженного банка не может внедрить разметку', () => {
    const { svc, clock } = setup();
    const evil = JSON.parse(JSON.stringify(DEMO_PACK));
    evil.questions[0].text = '<img src=x onerror=alert(1)>';
    evil.questions[0].options[0] = '<script>steal()</script>';
    svc.loadCustomPack(JSON.stringify(evil));
    svc.startQuestion(evil.questions[0].id);
    const out = sessionView(svc, clock.now()).value;
    assert.ok(!out.includes('<img src=x') && !out.includes('<script>steal'));
    assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });
});
