import type { QuestionBank } from './question-bank.ts';
import { createRng, shuffle, type Rng } from './rng.ts';
import { type AnswerOutcome, type SessionItem, nextUnanswered, resolveOption } from './session.ts';
import {
  type BankId,
  BLOCKS_PER_TICKET,
  DomainError,
  QUESTIONS_PER_BLOCK,
  type Question,
  blockOfPosition,
} from './types.ts';

/**
 * Правила теоретического экзамена в ГИБДД (Административный регламент МВД, приказ № 80):
 *  - 20 вопросов в 4 тематических блоках по 5, на ответы 20 минут;
 *  - ошибка в блоке → 5 дополнительных вопросов той же тематики и +5 минут;
 *  - 2 ошибки в одном блоке или более 2 ошибок всего → экзамен не сдан;
 *  - ошибка в дополнительном вопросе или истечение времени → экзамен не сдан.
 * Правила вынесены в конфиг: при изменении регламента меняются данные, а не код.
 */
export interface ExamRules {
  readonly baseTimeMs: number;
  readonly extraQuestionsPerError: number;
  readonly extraTimePerErrorMs: number;
  readonly maxErrors: number;
  readonly maxErrorsPerBlock: number;
  /** true — экзамен прерывается в момент провала (как в ГИБДД); false — можно дорешать до конца. */
  readonly failFast: boolean;
}

const MINUTE = 60_000;

export const GIBDD_EXAM_RULES: ExamRules = Object.freeze({
  baseTimeMs: 20 * MINUTE,
  extraQuestionsPerError: 5,
  extraTimePerErrorMs: 5 * MINUTE,
  maxErrors: 2,
  maxErrorsPerBlock: 1,
  failFast: true,
});

export type ExamVerdict = 'in_progress' | 'passed' | 'failed';
export type FailReason = 'block_errors' | 'total_errors' | 'extra_error' | 'timeout' | 'abandoned';

export const FAIL_REASON_TEXT: Readonly<Record<FailReason, string>> = {
  block_errors: 'Две ошибки в одном тематическом блоке',
  total_errors: 'Допущено более двух ошибок',
  extra_error: 'Ошибка в дополнительном вопросе',
  timeout: 'Истекло время экзамена',
  abandoned: 'Экзамен прерван',
};

export interface ExamItem extends SessionItem {
  /** Тематический блок 1..4. */
  readonly block: number;
  /** Дополнительный вопрос, добавленный за ошибку. */
  readonly extra: boolean;
  /** Вопрос, ошибка в котором добавила этот дополнительный вопрос. */
  readonly causedBy?: string;
}

export interface ExamState {
  readonly kind: 'exam';
  readonly id: string;
  readonly bankId: BankId;
  readonly rules: ExamRules;
  readonly shuffleOptions: boolean;
  readonly items: readonly ExamItem[];
  readonly cursor: number;
  readonly startedAt: number;
  readonly deadline: number;
  readonly verdict: ExamVerdict;
  readonly failReason?: FailReason;
  readonly finishedAt?: number;
  /** Состояние ГСЧ — дополнительные вопросы воспроизводимы после сериализации. */
  readonly rngState: number;
}

export interface ExamAnswerOutcome extends AnswerOutcome {
  readonly addedQuestions: number;
  readonly addedTimeMs: number;
  readonly verdict: ExamVerdict;
  readonly failReason?: FailReason;
}

export interface CreateExamParams {
  readonly id: string;
  readonly now: number;
  readonly seed: number;
  readonly rules?: ExamRules;
  readonly shuffleOptions?: boolean;
}

/**
 * Формирует экзамен как в ГИБДД: вопрос на каждой позиции 1..20 берётся из случайного билета,
 * поэтому тематика блоков сохраняется, а комбинация вопросов уникальна.
 */
export function createExam(bank: QuestionBank, p: CreateExamParams): ExamState {
  const rules = p.rules ?? GIBDD_EXAM_RULES;
  const shuffleOptions = p.shuffleOptions ?? false;
  const rng = createRng(p.seed);
  const used = new Set<string>();
  const items: ExamItem[] = [];
  const positions = BLOCKS_PER_TICKET * QUESTIONS_PER_BLOCK;

  for (let position = 0; position < positions; position++) {
    const block = blockOfPosition(position);
    const fromTickets = shuffle(bank.tickets, rng)
      .map((t) => t.questionIds[position])
      .find((id): id is string => id !== undefined && !used.has(id));
    const questionId = fromTickets ?? shuffle(bank.blockIds(block), rng).find((id) => !used.has(id));
    if (questionId === undefined) {
      throw new DomainError('bank_too_small', `В банке ${bank.id} недостаточно вопросов для блока ${block}`);
    }
    used.add(questionId);
    items.push(examItem(bank, questionId, block, false, rng, shuffleOptions));
  }

  return {
    kind: 'exam',
    id: p.id,
    bankId: bank.id,
    rules,
    shuffleOptions,
    items,
    cursor: 0,
    startedAt: p.now,
    deadline: p.now + rules.baseTimeMs,
    verdict: 'in_progress',
    rngState: rng.state(),
  };
}

function examItem(
  bank: QuestionBank,
  questionId: string,
  block: number,
  extra: boolean,
  rng: Rng,
  shuffleOptions: boolean,
  causedBy?: string,
): ExamItem {
  const indices = bank.get(questionId).options.map((_, i) => i);
  return {
    questionId,
    optionOrder: shuffleOptions ? shuffle(indices, rng) : indices,
    block,
    extra,
    ...(causedBy !== undefined ? { causedBy } : {}),
  };
}

/**
 * Подбор дополнительных вопросов: из того же тематического блока, в первую очередь — той же темы,
 * что и вопрос с ошибкой. Если блок исчерпан, добираем из всего банка с приоритетом темы.
 */
export function pickExtraQuestions(
  bank: QuestionBank,
  block: number,
  erred: Question,
  used: ReadonlySet<string>,
  count: number,
  rng: Rng,
): string[] {
  const topics = new Set(erred.topicIds);
  const sameTopicFirst = (ids: readonly string[]) => {
    const shuffled = shuffle(ids.filter((id) => !used.has(id)), rng);
    const score = (id: string) => (bank.get(id).topicIds.some((t) => topics.has(t)) ? 0 : 1);
    return shuffled.sort((a, b) => score(a) - score(b));
  };
  const picked = sameTopicFirst(bank.blockIds(block)).slice(0, count);
  if (picked.length < count) {
    const taken = new Set(picked);
    const rest = sameTopicFirst(bank.allIds()).filter((id) => !taken.has(id));
    picked.push(...rest.slice(0, count - picked.length));
  }
  return picked;
}

function closeIfDue(state: ExamState, now: number): ExamState {
  if (state.verdict !== 'in_progress') return state;
  if (now >= state.deadline) {
    return { ...state, verdict: 'failed', failReason: state.failReason ?? 'timeout', finishedAt: state.deadline };
  }
  return state;
}

export function answerExam(
  state: ExamState,
  bank: QuestionBank,
  itemIndex: number,
  displayedIndex: number,
  now: number,
): { state: ExamState; outcome?: ExamAnswerOutcome } {
  if (state.verdict !== 'in_progress') throw new DomainError('exam_finished', 'Экзамен уже завершён');
  const timed = closeIfDue(state, now);
  if (timed.verdict !== 'in_progress') return { state: timed };

  const item = state.items[itemIndex];
  if (!item) throw new DomainError('bad_index', `Нет вопроса №${itemIndex + 1}`);
  if (item.answer !== undefined) throw new DomainError('already_answered', 'На этот вопрос уже дан ответ');

  const question = bank.get(item.questionId);
  const chosen = resolveOption(item, displayedIndex);
  const correct = chosen === question.correctIndex;
  const items: ExamItem[] = state.items.slice();
  items[itemIndex] = { ...item, answer: chosen, correct };

  let { deadline, failReason } = state;
  let verdict: ExamVerdict = state.verdict;
  let finishedAt: number | undefined;
  let rngState = state.rngState;
  let addedQuestions = 0;
  let addedTimeMs = 0;

  const fail = (reason: FailReason) => {
    failReason ??= reason;
    if (state.rules.failFast) {
      verdict = 'failed';
      finishedAt = now;
    }
  };

  if (!correct) {
    const baseErrors = items.filter((i) => !i.extra && i.correct === false);
    const blockErrors = baseErrors.filter((i) => i.block === item.block).length;
    if (item.extra) fail('extra_error');
    else if (blockErrors > state.rules.maxErrorsPerBlock) fail('block_errors');
    else if (baseErrors.length > state.rules.maxErrors) fail('total_errors');
    else if (failReason === undefined) {
      const rng = createRng(state.rngState);
      const used = new Set(items.map((i) => i.questionId));
      const extraIds = pickExtraQuestions(bank, item.block, question, used, state.rules.extraQuestionsPerError, rng);
      for (const id of extraIds) {
        items.push(examItem(bank, id, item.block, true, rng, state.shuffleOptions, question.id));
      }
      rngState = rng.state();
      addedQuestions = extraIds.length;
      addedTimeMs = state.rules.extraTimePerErrorMs;
      deadline += addedTimeMs;
    }
  }

  if (verdict === 'in_progress' && items.every((i) => i.answer !== undefined)) {
    verdict = failReason ? 'failed' : 'passed';
    finishedAt = now;
  }

  const next = nextUnanswered(items, itemIndex);
  const nextState: ExamState = {
    ...state,
    items,
    deadline,
    verdict,
    rngState,
    cursor: next < 0 ? itemIndex : next,
    ...(failReason !== undefined ? { failReason } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
  };
  return {
    state: nextState,
    outcome: {
      questionId: item.questionId,
      correct,
      chosenIndex: chosen,
      correctIndex: question.correctIndex,
      finished: verdict !== 'in_progress',
      addedQuestions,
      addedTimeMs,
      verdict,
      ...(failReason !== undefined ? { failReason } : {}),
    },
  };
}

/** «Пропустить»: вопрос остаётся неотвеченным, к нему вернёмся по кругу. */
export function skipExamQuestion(state: ExamState): ExamState {
  if (state.verdict !== 'in_progress') return state;
  const next = nextUnanswered(state.items, state.cursor);
  return next < 0 ? state : { ...state, cursor: next };
}

export function goToExamItem(state: ExamState, index: number): ExamState {
  if (index < 0 || index >= state.items.length) throw new DomainError('bad_index', `Нет вопроса №${index + 1}`);
  return { ...state, cursor: index };
}

/** Проверка таймера: вызывается клиентом раз в секунду и сервером при каждом запросе. */
export function tickExam(state: ExamState, now: number): ExamState {
  return closeIfDue(state, now);
}

export function abandonExam(state: ExamState, now: number): ExamState {
  if (state.verdict !== 'in_progress') return state;
  return { ...state, verdict: 'failed', failReason: state.failReason ?? 'abandoned', finishedAt: now };
}

export function remainingMs(state: ExamState, now: number): number {
  const end = state.verdict === 'in_progress' ? now : (state.finishedAt ?? now);
  return Math.max(0, state.deadline - end);
}

export interface ExamSummary {
  readonly verdict: ExamVerdict;
  readonly failReason?: FailReason;
  readonly total: number;
  readonly answered: number;
  readonly errors: number;
  readonly baseErrors: number;
  readonly extraErrors: number;
  readonly extraQuestions: number;
  readonly durationMs: number;
  readonly blocks: readonly { readonly block: number; readonly errors: number; readonly extended: boolean }[];
  readonly wrongIds: readonly string[];
}

export function summarizeExam(state: ExamState, now: number): ExamSummary {
  const wrong = state.items.filter((i) => i.correct === false);
  const blocks = Array.from({ length: BLOCKS_PER_TICKET }, (_, i) => {
    const block = i + 1;
    return {
      block,
      errors: wrong.filter((w) => !w.extra && w.block === block).length,
      extended: state.items.some((it) => it.extra && it.block === block),
    };
  });
  return {
    verdict: state.verdict,
    ...(state.failReason !== undefined ? { failReason: state.failReason } : {}),
    total: state.items.length,
    answered: state.items.filter((i) => i.answer !== undefined).length,
    errors: wrong.length,
    baseErrors: wrong.filter((w) => !w.extra).length,
    extraErrors: wrong.filter((w) => w.extra).length,
    extraQuestions: state.items.filter((i) => i.extra).length,
    durationMs: (state.finishedAt ?? now) - state.startedAt,
    blocks,
    wrongIds: wrong.map((w) => w.questionId),
  };
}
