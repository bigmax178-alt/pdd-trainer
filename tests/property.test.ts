/**
 * Property-based тесты: сотни случайных (но воспроизводимых) прогонов проверяют инварианты,
 * которые должны выполняться при любом поведении ученика.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ExamState, GIBDD_EXAM_RULES, answerExam, createExam, skipExamQuestion } from '../src/core/exam.ts';
import {
  type Progress, emptyProgress, mergeProgress, parseProgress, recordAnswer, recordTicket, toggleFavorite,
} from '../src/core/progress.ts';
import { QuestionBank } from '../src/core/question-bank.ts';
import { createRng, type Rng } from '../src/core/rng.ts';
import { passProbability } from '../src/core/stats.ts';
import { DEMO_PACK } from '../src/content/demo-bank.ts';
import { DAY, MIN, T0, right, wrong } from './fixtures.ts';

const banks = { AB: new QuestionBank(DEMO_PACK, 'AB'), CD: new QuestionBank(DEMO_PACK, 'CD') };

/** Ученик: на вопрос блока b отвечает верно с вероятностью p[b-1], иногда пропускает. */
function simulate(bank: QuestionBank, p: readonly number[], rng: Rng, seed: number): ExamState {
  let s = createExam(bank, { id: `x${seed}`, now: T0, seed, rules: GIBDD_EXAM_RULES });
  let t = T0;
  for (let guard = 0; s.verdict === 'in_progress' && guard < 200; guard++) {
    if (rng.next() < 0.05) { s = skipExamQuestion(s, t); continue; }
    const item = s.items[s.cursor];
    assert.ok(item);
    const ok = rng.next() < (p[item.block - 1] ?? 1);
    t += 1000;
    s = answerExam(s, bank, s.cursor, ok ? right(s, bank) : wrong(s, bank), t).state;
  }
  return s;
}

describe('Инварианты экзамена (500 случайных прогонов на банках AB и CD)', () => {
  it('структура, время и вердикт всегда согласованы с правилами', () => {
    const rng = createRng(2026);
    for (let seed = 1; seed <= 500; seed++) {
      const bank = seed % 2 ? banks.AB : banks.CD;
      const p = [0, 1, 2, 3].map(() => 0.75 + rng.next() * 0.25);
      const s = simulate(bank, p, rng, seed);
      const base = s.items.filter((i) => !i.extra);
      const extras = s.items.filter((i) => i.extra);
      const baseErrors = base.filter((i) => i.correct === false);
      const extendedBlocks = new Set(extras.map((e) => e.block));

      assert.equal(base.length, 20);
      assert.equal(new Set(s.items.map((i) => i.questionId)).size, s.items.length, 'вопросы не повторяются');
      assert.ok(s.items.length <= 30, 'не более 10 дополнительных вопросов');
      assert.equal(extras.length % 5, 0);
      assert.equal(s.deadline - s.startedAt, 20 * MIN + extendedBlocks.size * 5 * MIN, 'время = 20 мин + 5 за каждую ошибку');
      for (const e of extras) {
        const cause = s.items.find((i) => i.questionId === e.causedBy);
        assert.ok(cause && !cause.extra && cause.correct === false && cause.block === e.block, 'доп. вопрос привязан к ошибке своего блока');
      }
      assert.notEqual(s.verdict, 'in_progress');
      if (s.verdict === 'passed') {
        assert.ok(s.items.every((i) => i.answer !== undefined));
        assert.ok(baseErrors.length <= 2);
        assert.ok(extras.every((e) => e.correct));
        assert.equal(new Set(baseErrors.map((e) => e.block)).size, baseErrors.length, 'не более одной ошибки в блоке');
      } else {
        assert.ok(s.failReason);
        if (s.failReason === 'extra_error') assert.ok(extras.some((e) => e.correct === false));
        if (s.failReason === 'block_errors') {
          assert.ok([1, 2, 3, 4].some((b) => baseErrors.filter((e) => e.block === b).length >= 2));
        }
        if (s.failReason === 'total_errors') assert.ok(baseErrors.length >= 3);
      }
    }
  });

  it('формула вероятности сдачи совпадает с симуляцией движка экзамена (Монте-Карло)', () => {
    const cases = [
      [0.9, 0.9, 0.9, 0.9],
      [0.97, 0.85, 0.95, 0.9],
      [0.8, 0.95, 0.99, 0.75],
    ];
    for (const p of cases) {
      const rng = createRng(7);
      const runs = 4000;
      let passed = 0;
      for (let i = 0; i < runs; i++) if (simulate(banks.AB, p, rng, 10_000 + i).verdict === 'passed') passed++;
      const expected = passProbability(p);
      assert.ok(Math.abs(passed / runs - expected) < 0.03, `p=${p}: симуляция ${passed / runs}, формула ${expected}`);
    }
  });
});

function randomProgress(rng: Rng, ids: readonly string[], steps: number, start: number): Progress {
  let p = emptyProgress(start);
  let t = start;
  for (let i = 0; i < steps; i++) {
    t += Math.floor(rng.next() * DAY);
    const id = ids[rng.int(ids.length)] ?? 'x';
    const r = rng.next();
    if (r < 0.8) p = recordAnswer(p, id, rng.next() < 0.7, t);
    else if (r < 0.9) p = toggleFavorite(p, id, t);
    else p = recordTicket(p, 'AB', 1 + rng.int(3), rng.int(5), t);
  }
  return p;
}

describe('Слияние прогресса (синхронизация устройств)', () => {
  const ids = banks.AB.allIds();
  const norm = (p: Progress) => ({ ...p, mistakes: [...p.mistakes].sort(), favorites: [...p.favorites].sort() });

  it('коммутативно, идемпотентно и не теряет отвеченные вопросы', () => {
    const rng = createRng(99);
    for (let i = 0; i < 200; i++) {
      const a = randomProgress(rng, ids, 1 + rng.int(40), T0);
      const b = randomProgress(rng, ids, 1 + rng.int(40), T0 + rng.int(1000));
      assert.deepEqual(norm(mergeProgress(a, b)), norm(mergeProgress(b, a)));
      assert.deepEqual(norm(mergeProgress(a, a)), norm(a));
      const m = mergeProgress(a, b);
      for (const id of [...Object.keys(a.questions), ...Object.keys(b.questions)]) assert.ok(m.questions[id]);
      assert.deepEqual(parseProgress(JSON.parse(JSON.stringify(m))), m, 'переживает сериализацию');
    }
  });
});
