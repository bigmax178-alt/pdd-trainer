import type { ExamState } from '../src/core/exam.ts';
import type { QuestionBank } from '../src/core/question-bank.ts';
import type { PracticeState } from '../src/core/session.ts';
import { type ContentPack, type Question, blockOfPosition } from '../src/core/types.ts';

export const T0 = new Date(2026, 9, 10, 12, 0, 0).getTime();
export const MIN = 60_000;
export const DAY = 86_400_000;

/**
 * Синтетический банк с предсказуемой структурой: в каждом блоке две темы (чётные и нечётные позиции),
 * правильный ответ — (номер билета + позиция) mod 3.
 */
export function syntheticPack(ticketCount = 3): ContentPack {
  const questions: Question[] = [];
  const tickets = [];
  for (let t = 1; t <= ticketCount; t++) {
    const ids: string[] = [];
    for (let pos = 0; pos < 20; pos++) {
      const id = `q${t}-${pos}`;
      const block = blockOfPosition(pos);
      questions.push({
        id,
        text: `Вопрос ${pos + 1} билета ${t}`,
        options: ['Вариант A', 'Вариант B', 'Вариант C'],
        correctIndex: (t + pos) % 3,
        explanation: 'Пояснение',
        topicIds: [`b${block}-${pos % 2}`],
      });
      ids.push(id);
    }
    tickets.push({ number: t, questionIds: ids });
  }
  const topics = [1, 2, 3, 4].flatMap((b) => [0, 1].map((k) => ({ id: `b${b}-${k}`, title: `Блок ${b}, тема ${k}` })));
  return { version: 'test', title: 'Синтетика', topics, questions, banks: { AB: tickets, CD: tickets.slice(0, 2) } };
}

type AnyState = ExamState | PracticeState;

/** Показанный индекс правильного варианта для вопроса i. */
export function right(s: AnyState, bank: QuestionBank, i = s.cursor): number {
  const item = s.items[i];
  if (!item) throw new Error(`no item ${i}`);
  return item.optionOrder.indexOf(bank.get(item.questionId).correctIndex);
}

export function wrong(s: AnyState, bank: QuestionBank, i = s.cursor): number {
  const item = s.items[i];
  if (!item) throw new Error(`no item ${i}`);
  return (right(s, bank, i) + 1) % item.optionOrder.length;
}

export class FakeClock {
  t: number;
  constructor(t = T0) {
    this.t = t;
  }
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}
