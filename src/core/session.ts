import type { QuestionBank } from './question-bank.ts';
import { type Rng, shuffle } from './rng.ts';
import { type BankId, DomainError } from './types.ts';

export type PracticeMode =
  | 'ticket' | 'topic' | 'marathon' | 'mistakes' | 'favorites'
  | 'hard' | 'smart' | 'review' | 'search';

export interface SessionItem {
  readonly questionId: string;
  /** Порядок показа вариантов: optionOrder[показанный индекс] = исходный индекс. */
  readonly optionOrder: readonly number[];
  /** Исходный индекс выбранного варианта. */
  readonly answer?: number;
  readonly correct?: boolean;
}

export interface PracticeState {
  readonly kind: 'practice';
  readonly id: string;
  readonly mode: PracticeMode;
  readonly bankId: BankId;
  readonly title: string;
  readonly ticketNumber?: number;
  readonly topicId?: string;
  readonly items: readonly SessionItem[];
  readonly cursor: number;
  readonly startedAt: number;
  readonly finishedAt?: number;
}

export interface AnswerOutcome {
  readonly questionId: string;
  readonly correct: boolean;
  readonly chosenIndex: number;
  readonly correctIndex: number;
  readonly finished: boolean;
}

export interface CreatePracticeParams {
  readonly id: string;
  readonly mode: PracticeMode;
  readonly bank: QuestionBank;
  readonly questionIds: readonly string[];
  readonly title: string;
  readonly now: number;
  readonly rng: Rng;
  readonly shuffleOptions: boolean;
  readonly ticketNumber?: number;
  readonly topicId?: string;
}

export function makeItem(bank: QuestionBank, questionId: string, rng: Rng, shuffleOptions: boolean): SessionItem {
  const indices = bank.get(questionId).options.map((_, i) => i);
  return { questionId, optionOrder: shuffleOptions ? shuffle(indices, rng) : indices };
}

export function createPractice(p: CreatePracticeParams): PracticeState {
  if (p.questionIds.length === 0) throw new DomainError('empty_session', 'Нет вопросов для тренировки');
  if (new Set(p.questionIds).size !== p.questionIds.length) {
    throw new DomainError('duplicate_questions', 'Вопросы в сессии не должны повторяться');
  }
  return {
    kind: 'practice',
    id: p.id,
    mode: p.mode,
    bankId: p.bank.id,
    title: p.title,
    ...(p.ticketNumber !== undefined ? { ticketNumber: p.ticketNumber } : {}),
    ...(p.topicId !== undefined ? { topicId: p.topicId } : {}),
    items: p.questionIds.map((id) => makeItem(p.bank, id, p.rng, p.shuffleOptions)),
    cursor: 0,
    startedAt: p.now,
  };
}

/** Перевод показанного индекса варианта в исходный с проверкой границ. */
export function resolveOption(item: SessionItem, displayedIndex: number): number {
  const original = item.optionOrder[displayedIndex];
  if (!Number.isInteger(displayedIndex) || original === undefined) {
    throw new DomainError('bad_option', `Нет варианта ответа с номером ${displayedIndex + 1}`);
  }
  return original;
}

/** Следующий неотвеченный вопрос после `from` по кругу; -1, если все отвечены. */
export function nextUnanswered(items: readonly SessionItem[], from: number): number {
  for (let step = 1; step <= items.length; step++) {
    const i = (from + step) % items.length;
    if (items[i]?.answer === undefined) return i;
  }
  return -1;
}

export function answerPractice(
  state: PracticeState,
  bank: QuestionBank,
  itemIndex: number,
  displayedIndex: number,
  now: number,
): { state: PracticeState; outcome: AnswerOutcome } {
  if (state.finishedAt !== undefined) throw new DomainError('session_finished', 'Тренировка уже завершена');
  const item = state.items[itemIndex];
  if (!item) throw new DomainError('bad_index', `Нет вопроса №${itemIndex + 1}`);
  if (item.answer !== undefined) throw new DomainError('already_answered', 'На этот вопрос уже дан ответ');

  const chosen = resolveOption(item, displayedIndex);
  const question = bank.get(item.questionId);
  const correct = chosen === question.correctIndex;
  const items = state.items.slice();
  items[itemIndex] = { ...item, answer: chosen, correct };
  const finished = items.every((i) => i.answer !== undefined);
  return {
    state: { ...state, items, cursor: itemIndex, ...(finished ? { finishedAt: now } : {}) },
    outcome: { questionId: item.questionId, correct, chosenIndex: chosen, correctIndex: question.correctIndex, finished },
  };
}

/** Переход к следующему неотвеченному вопросу (после показа разбора). */
export function advancePractice(state: PracticeState): PracticeState {
  const next = nextUnanswered(state.items, state.cursor);
  return next < 0 ? state : { ...state, cursor: next };
}

export function goToItem(state: PracticeState, index: number): PracticeState {
  if (index < 0 || index >= state.items.length) throw new DomainError('bad_index', `Нет вопроса №${index + 1}`);
  return { ...state, cursor: index };
}

export function finishPractice(state: PracticeState, now: number): PracticeState {
  return state.finishedAt !== undefined ? state : { ...state, finishedAt: now };
}

export interface PracticeSummary {
  readonly total: number;
  readonly answered: number;
  readonly correct: number;
  readonly wrong: number;
  readonly wrongIds: readonly string[];
  readonly durationMs: number;
}

export function summarizePractice(state: PracticeState, now: number): PracticeSummary {
  const answered = state.items.filter((i) => i.answer !== undefined);
  const wrongIds = answered.filter((i) => !i.correct).map((i) => i.questionId);
  return {
    total: state.items.length,
    answered: answered.length,
    correct: answered.length - wrongIds.length,
    wrong: wrongIds.length,
    wrongIds,
    durationMs: (state.finishedAt ?? now) - state.startedAt,
  };
}
