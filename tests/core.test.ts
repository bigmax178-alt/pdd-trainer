import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSmartSet } from '../src/core/adaptive.ts';
import {
  MISTAKE_CLEAR_STREAK, ProgressFormatError, emptyProgress, parseProgress, recordAnswer, recordExam,
  recordTicket, toggleFavorite, MAX_EXAM_HISTORY,
} from '../src/core/progress.ts';
import { QuestionBank } from '../src/core/question-bank.ts';
import { createRng, hashString, shuffle } from '../src/core/rng.ts';
import {
  advancePractice, answerPractice, createPractice, finishPractice, summarizePractice,
} from '../src/core/session.ts';
import { LEITNER_INTERVALS_DAYS, isDue, scheduleCard } from '../src/core/srs.ts';
import {
  currentStreak, dueQuestions, hardQuestions, passProbability, readiness, ticketStatuses, topicMastery,
} from '../src/core/stats.ts';
import { DomainError } from '../src/core/types.ts';
import { DAY, T0, right, syntheticPack, wrong } from './fixtures.ts';

const bank = new QuestionBank(syntheticPack(3), 'AB');

describe('ГСЧ', () => {
  it('воспроизводим и равномерен', () => {
    const a = createRng(1), b = createRng(1);
    for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
    const r = createRng(3);
    const buckets = [0, 0, 0, 0];
    for (let i = 0; i < 40_000; i++) buckets[r.int(4)]!++;
    for (const n of buckets) assert.ok(Math.abs(n - 10_000) < 500);
  });
  it('shuffle — перестановка без потерь', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    assert.deepEqual(shuffle(items, createRng(5)).sort((x, y) => x - y), items);
    assert.equal(hashString('ab1-01'), hashString('ab1-01'));
  });
});

describe('Банк вопросов', () => {
  it('индексирует билеты, блоки и темы', () => {
    assert.equal(bank.size, 60);
    assert.equal(bank.blockIds(1).length, 15);
    assert.equal(bank.blockOf('q2-7'), 2);
    assert.equal(bank.topicIds('b1-0').length, 9);
    assert.deepEqual(bank.locate('q3-19'), { ticket: 3, position: 20 });
    assert.throws(() => bank.ticket(99), DomainError);
    assert.throws(() => bank.get('nope'), DomainError);
  });
  it('поиск регистронезависим, все слова запроса должны встретиться', () => {
    assert.deepEqual(bank.search('ВОПРОС 20 билета'), ['q1-19', 'q2-19', 'q3-19']);
    assert.deepEqual(bank.search('вопрос 20 билетов'), []);
    assert.deepEqual(bank.search('x'), [], 'слишком короткий запрос');
  });
});

describe('Тренировочная сессия', () => {
  const ids = bank.ticket(1).questionIds;
  const make = (shuffleOptions: boolean) =>
    createPractice({ id: 's', mode: 'ticket', bank, questionIds: ids, title: 'Билет 1', now: T0, rng: createRng(1), shuffleOptions });

  it('перемешивание вариантов не ломает проверку ответа', () => {
    let s = make(true);
    for (let i = 0; i < ids.length; i++) {
      const ok = i % 3 !== 0;
      const r = answerPractice(s, bank, s.cursor, ok ? right(s, bank) : wrong(s, bank), T0 + i);
      assert.equal(r.outcome.correct, ok);
      s = advancePractice(r.state, T0 + i);
    }
    const sum = summarizePractice(s, T0 + 100);
    assert.equal(sum.wrong, 7);
    assert.equal(sum.answered, 20);
    assert.ok(s.finishedAt !== undefined);
  });
  it('отклоняет пустые, дублирующиеся и повторные ответы', () => {
    const p = { id: 's', mode: 'topic' as const, bank, title: 't', now: T0, rng: createRng(1), shuffleOptions: false };
    assert.throws(() => createPractice({ ...p, questionIds: [] }), DomainError);
    assert.throws(() => createPractice({ ...p, questionIds: ['q1-0', 'q1-0'] }), DomainError);
    const s = answerPractice(make(false), bank, 0, 0, T0).state;
    assert.throws(() => answerPractice(s, bank, 0, 1, T0), DomainError);
    assert.throws(() => answerPractice(finishPractice(make(false), T0), bank, 0, 0, T0), DomainError);
  });
});

describe('Прогресс и интервальное повторение', () => {
  it('Лейтнер: верный ответ повышает коробку, ошибка возвращает в первую', () => {
    let card = scheduleCard(undefined, true, T0);
    assert.equal(card.box, 1);
    card = scheduleCard(card, true, T0);
    assert.equal(card.box, 2);
    assert.equal(card.dueAt, T0 + (LEITNER_INTERVALS_DAYS[2] ?? 0) * DAY);
    assert.equal(scheduleCard(card, false, T0).box, 1);
    assert.ok(isDue(card, card.dueAt) && !isDue(card, card.dueAt - 1));
  });

  it(`«Работа над ошибками»: вопрос уходит после ${MISTAKE_CLEAR_STREAK} верных ответов подряд`, () => {
    let p = recordAnswer(emptyProgress(T0), 'q1-0', false, T0);
    assert.deepEqual(p.mistakes, ['q1-0']);
    p = recordAnswer(p, 'q1-0', true, T0 + 1);
    assert.deepEqual(p.mistakes, ['q1-0']);
    p = recordAnswer(p, 'q1-0', true, T0 + 2);
    assert.deepEqual(p.mistakes, []);
    assert.equal(p.questions['q1-0']?.attempts, 3);
    assert.equal(p.questions['q1-0']?.correct, 2);
  });

  it('билеты, избранное, история экзаменов', () => {
    let p = recordTicket(emptyProgress(T0), 'AB', 1, 3, T0);
    p = recordTicket(p, 'AB', 1, 0, T0 + 1);
    p = recordTicket(p, 'AB', 1, 2, T0 + 2);
    assert.deepEqual(p.tickets['AB:1'], { attempts: 3, lastErrors: 2, bestErrors: 0, lastAt: T0 + 2 });
    p = toggleFavorite(toggleFavorite(p, 'a', T0), 'b', T0);
    assert.deepEqual(toggleFavorite(p, 'a', T0).favorites, ['b']);
    const rec = { id: 'e', bankId: 'AB' as const, startedAt: T0, finishedAt: T0, passed: true, total: 20, errors: 0 };
    assert.equal(recordExam(recordExam(p, rec, T0), rec, T0).exams.length, 1, 'повторная запись не дублируется');
    for (let i = 0; i < MAX_EXAM_HISTORY + 5; i++) p = recordExam(p, { ...rec, id: `e${i}` }, T0);
    assert.equal(p.exams.length, MAX_EXAM_HISTORY);
  });

  it('parseProgress санитизирует мусор и отвергает чужие форматы', () => {
    const p = parseProgress({
      schemaVersion: 1,
      questions: { a: { attempts: 2, correct: 9, streak: -1, box: 99, lastCorrect: 'yes' }, b: { attempts: 0 }, c: 'x' },
      mistakes: ['a', 'a', 5, ''],
      tickets: { 'AB:1': { attempts: 1, lastErrors: 2, bestErrors: 1, lastAt: 1 }, hack: {} },
      exams: [{ id: 'e', bankId: 'ZZ' }, { id: 'f', bankId: 'CD', passed: true, failReason: 'bogus' }],
      activity: { '2026-10-10': 5, bad: 3 },
    });
    assert.deepEqual(p.questions.a, { attempts: 2, correct: 2, streak: 0, lastAt: 0, lastCorrect: false, box: 5, dueAt: 0, timeMs: 0 });
    assert.equal(p.questions.b, undefined);
    assert.deepEqual(p.mistakes, ['a']);
    assert.deepEqual(Object.keys(p.tickets), ['AB:1']);
    assert.equal(p.exams.length, 1);
    assert.equal(p.exams[0]?.failReason, undefined);
    assert.deepEqual(p.activity, { '2026-10-10': 5 });
    assert.throws(() => parseProgress(null), ProgressFormatError);
    assert.throws(() => parseProgress({ schemaVersion: 99 }), /новой версией/);
    assert.throws(() => parseProgress({}), ProgressFormatError);
  });
});

describe('Статистика и готовность', () => {
  it('вероятность сдачи: крайние случаи и монотонность', () => {
    assert.equal(passProbability([1, 1, 1, 1]), 1);
    assert.equal(passProbability([0, 0, 0, 0]), 0);
    // Ровно одна ошибка в одном блоке при p→1: проверяем по формуле вручную для одного «слабого» блока.
    const p = 0.9;
    const clean = p ** 5, oneErr = 5 * p ** 4 * (1 - p) * p ** 5;
    assert.ok(Math.abs(passProbability([p, 1, 1, 1]) - (clean + oneErr)) < 1e-12);
    let prev = 0;
    for (let x = 0.5; x <= 1.0001; x += 0.05) {
      const v = passProbability([x, x, x, x]);
      assert.ok(v >= prev - 1e-12);
      prev = v;
    }
  });

  it('готовность растёт по мере правильных ответов', () => {
    const before = readiness(bank, emptyProgress(T0)).probability;
    let p = emptyProgress(T0);
    for (const id of bank.allIds()) for (let k = 0; k < 3; k++) p = recordAnswer(p, id, true, T0 + k);
    const after = readiness(bank, p);
    assert.ok(before < 0.01);
    assert.ok(after.probability > 0.5 && after.probability > before);
    assert.equal(after.blocks.length, 4);
  });

  it('серия дней, сложные вопросы, повторение, темы и билеты', () => {
    const day = (offset: number) => new Date(2026, 9, 10 + offset, 12).getTime();
    let p = emptyProgress(T0);
    for (const o of [-3, -2, -1]) p = recordAnswer(p, 'q1-0', true, day(o));
    assert.equal(currentStreak(p.activity, day(0)), 3, 'сегодня ещё не занимались — серия не прервана');
    p = recordAnswer(p, 'q1-1', false, day(0));
    assert.equal(currentStreak(p.activity, day(0)), 4);
    assert.equal(currentStreak(p.activity, day(2)), 0);

    p = recordAnswer(recordAnswer(p, 'q1-2', false, T0), 'q1-2', false, T0);
    assert.deepEqual(hardQuestions(bank, p, 2), ['q1-2', 'q1-1']);
    assert.ok(!dueQuestions(bank, p, day(5)).includes('q1-0'), 'коробка 3 — повтор через 7 дней');
    assert.ok(dueQuestions(bank, p, day(6)).includes('q1-0'));
    assert.ok(topicMastery(bank, p).some((t) => t.topicId === 'b1-0' && t.seen === 2));

    p = recordTicket(recordTicket(p, 'AB', 1, 0, T0), 'AB', 2, 4, T0);
    assert.deepEqual(ticketStatuses(bank, p).map((t) => t.status), ['perfect', 'failed', 'new']);
  });

  it('умная тренировка: без повторов, ошибки выбираются заметно чаще выученных', () => {
    let p = emptyProgress(T0);
    const mistake = 'q1-5';
    const mastered = 'q2-5';
    p = recordAnswer(p, mistake, false, T0 - DAY);
    for (let k = 0; k < 5; k++) p = recordAnswer(p, mastered, true, T0 - DAY);
    let hitsMistake = 0, hitsMastered = 0;
    for (let seed = 0; seed < 300; seed++) {
      const set = buildSmartSet(bank, p, 10, T0, createRng(seed));
      assert.equal(new Set(set).size, 10);
      if (set.includes(mistake)) hitsMistake++;
      if (set.includes(mastered)) hitsMastered++;
    }
    assert.ok(hitsMistake > hitsMastered * 3, `ошибки ${hitsMistake}, выученные ${hitsMastered}`);
  });
});
