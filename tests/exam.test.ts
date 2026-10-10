import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ExamState, GIBDD_EXAM_RULES, abandonExam, answerExam, createExam, pickExtraQuestions,
  remainingMs, skipExamQuestion, summarizeExam, tickExam,
} from '../src/core/exam.ts';
import { QuestionBank } from '../src/core/question-bank.ts';
import { createRng } from '../src/core/rng.ts';
import { DomainError } from '../src/core/types.ts';
import { MIN, T0, right, syntheticPack, wrong } from './fixtures.ts';

const bank = new QuestionBank(syntheticPack(3), 'AB');
const newExam = (seed = 42, rules = GIBDD_EXAM_RULES) => createExam(bank, { id: 'e1', now: T0, seed, rules });

/** Отвечает на текущий вопрос: верно или неверно. */
function step(s: ExamState, ok: boolean, now = T0 + MIN) {
  return answerExam(s, bank, s.cursor, ok ? right(s, bank) : wrong(s, bank), now);
}

/** Прогоняет экзамен по сценарию: ошибки на указанных позициях (по порядку ответов), остальное верно. */
function run(errorsAt: readonly number[], rules = GIBDD_EXAM_RULES): ExamState {
  let s = newExam(42, rules);
  let n = 0;
  while (s.verdict === 'in_progress') {
    s = step(s, !errorsAt.includes(n)).state;
    n++;
  }
  return s;
}

describe('Экзамен: формирование билета', () => {
  it('20 уникальных вопросов, по 5 в каждом из 4 блоков, 20 минут', () => {
    const s = newExam();
    assert.equal(s.items.length, 20);
    assert.equal(new Set(s.items.map((i) => i.questionId)).size, 20);
    for (let b = 1; b <= 4; b++) assert.equal(s.items.filter((i) => i.block === b).length, 5);
    assert.equal(s.deadline - s.startedAt, 20 * MIN);
    assert.equal(s.verdict, 'in_progress');
  });

  it('каждая позиция берётся с той же позиции одного из билетов (тематика блока сохраняется)', () => {
    newExam(7).items.forEach((item, pos) => {
      assert.ok(bank.tickets.some((t) => t.questionIds[pos] === item.questionId), `позиция ${pos}`);
    });
  });

  it('детерминирован при одинаковом сиде', () => {
    assert.deepEqual(newExam(5), newExam(5));
    assert.notDeepEqual(newExam(5).items, newExam(6).items);
  });
});

describe('Экзамен: правила ГИБДД', () => {
  it('без ошибок — сдан', () => {
    const s = run([]);
    assert.equal(s.verdict, 'passed');
    assert.equal(s.items.length, 20);
  });

  it('одна ошибка → +5 вопросов того же блока и +5 минут; решены верно — сдан', () => {
    let s = newExam();
    for (let i = 0; i < 6; i++) s = step(s, true).state;
    const erred = s.items[s.cursor];
    const { state, outcome } = step(s, false);
    assert.equal(outcome?.addedQuestions, 5);
    assert.equal(outcome?.addedTimeMs, 5 * MIN);
    assert.equal(state.items.length, 25);
    assert.equal(state.deadline, s.deadline + 5 * MIN);
    const extras = state.items.slice(20);
    assert.ok(extras.every((e) => e.extra && e.block === erred?.block && e.causedBy === erred?.questionId));
    assert.ok(extras.every((e) => bank.blockOf(e.questionId) === erred?.block), 'доп. вопросы из того же блока');
    assert.equal(new Set(state.items.map((i) => i.questionId)).size, 25, 'без повторов');
    let t = state;
    while (t.verdict === 'in_progress') t = step(t, true).state;
    assert.equal(t.verdict, 'passed');
  });

  it('доп. вопросы в первую очередь той же темы, что и вопрос с ошибкой', () => {
    const erred = bank.get('q1-0'); // тема b1-0
    const picked = pickExtraQuestions(bank, 1, erred, new Set(['q1-0']), 5, createRng(1));
    const sameTopic = bank.blockIds(1).filter((id) => id !== 'q1-0' && bank.get(id).topicIds.includes('b1-0'));
    // В блоке 1 ещё 8 вопросов темы b1-0 — значит все 5 доп. вопросов должны быть этой темы.
    assert.ok(sameTopic.length >= 5);
    assert.ok(picked.every((id) => bank.get(id).topicIds.includes('b1-0')));
  });

  it('две ошибки в разных блоках → +10 вопросов и +10 минут', () => {
    const s = run([0, 7]);
    assert.equal(s.items.length, 30);
    assert.equal(s.deadline - s.startedAt, 30 * MIN);
    assert.equal(s.verdict, 'passed');
  });

  it('две ошибки в одном блоке — не сдан сразу', () => {
    const s = run([0, 1]);
    assert.equal(s.verdict, 'failed');
    assert.equal(s.failReason, 'block_errors');
    assert.equal(s.items.filter((i) => i.answer !== undefined).length, 2, 'экзамен прерван на второй ошибке');
  });

  it('три ошибки в разных блоках — не сдан', () => {
    const s = run([0, 6, 12]);
    assert.equal(s.verdict, 'failed');
    assert.equal(s.failReason, 'total_errors');
  });

  it('ошибка в дополнительном вопросе — не сдан', () => {
    const s = run([0, 20]);
    assert.equal(s.verdict, 'failed');
    assert.equal(s.failReason, 'extra_error');
  });

  it('нестрогий режим: можно дорешать, итог «не сдан», доп. вопросы после провала не добавляются', () => {
    const s = run([0, 1, 10], { ...GIBDD_EXAM_RULES, failFast: false });
    assert.equal(s.verdict, 'failed');
    assert.equal(s.failReason, 'block_errors');
    assert.ok(s.items.every((i) => i.answer !== undefined), 'все вопросы отвечены');
    assert.equal(s.items.length, 25, 'только за первую ошибку');
  });

  it('истечение времени: ответ не принимается, экзамен не сдан', () => {
    const s = newExam();
    assert.equal(tickExam(s, T0 + 20 * MIN - 1), s, 'до дедлайна состояние не меняется');
    const late = answerExam(s, bank, 0, right(s, bank), T0 + 20 * MIN);
    assert.equal(late.outcome, undefined);
    assert.equal(late.state.verdict, 'failed');
    assert.equal(late.state.failReason, 'timeout');
    assert.equal(remainingMs(late.state, T0 + 30 * MIN), 0);
  });

  it('недопустимые операции отклоняются доменной ошибкой', () => {
    const s = newExam();
    const once = step(s, true).state;
    assert.throws(() => answerExam(once, bank, 0, 0, T0), (e: DomainError) => e.code === 'already_answered');
    assert.throws(() => answerExam(s, bank, 0, 99, T0), (e: DomainError) => e.code === 'bad_option');
    assert.throws(() => answerExam(s, bank, 99, 0, T0), (e: DomainError) => e.code === 'bad_index');
    const done = run([]);
    assert.throws(() => answerExam(done, bank, 0, 0, T0), (e: DomainError) => e.code === 'exam_finished');
  });

  it('«Пропустить» переходит к следующему неотвеченному по кругу', () => {
    let s = newExam();
    s = skipExamQuestion(s, T0);
    assert.equal(s.cursor, 1);
    s = { ...s, cursor: 19 };
    assert.equal(skipExamQuestion(s, T0).cursor, 0);
  });

  it('прерывание экзамена и сводка', () => {
    const s = abandonExam(step(newExam(), false).state, T0 + 3 * MIN);
    assert.equal(s.verdict, 'failed');
    assert.equal(s.failReason, 'abandoned');
    const sum = summarizeExam(s, T0 + 10 * MIN);
    assert.equal(sum.errors, 1);
    assert.equal(sum.extraQuestions, 5);
    assert.equal(sum.durationMs, 3 * MIN);
    assert.equal(sum.blocks[0]?.errors, 1);
    assert.equal(sum.blocks[0]?.extended, true);
  });

  it('сериализация в JSON не меняет дальнейший ход экзамена (состояние ГСЧ сохраняется)', () => {
    const s = step(newExam(), true).state;
    const copy = JSON.parse(JSON.stringify(s)) as ExamState;
    assert.deepEqual(step(copy, false).state, step(s, false).state);
  });
});
