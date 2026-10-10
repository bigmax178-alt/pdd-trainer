import { type ExamRules, GIBDD_EXAM_RULES } from './exam.ts';
import { type Progress, type QuestionStat, dayKey, ticketKey } from './progress.ts';
import type { QuestionBank } from './question-bank.ts';
import { isDue, isMastered } from './srs.ts';
import { BLOCKS_PER_TICKET, QUESTIONS_PER_BLOCK } from './types.ts';

/** Штраф к оценке для ещё не встреченных вопросов: незнакомый вопрос решается хуже среднего. */
export const UNSEEN_FACTOR = 0.85;

export interface BankOverview {
  readonly total: number;
  readonly seen: number;
  readonly mastered: number;
  readonly attempts: number;
  readonly correct: number;
  readonly accuracy: number;
  readonly mistakes: number;
  readonly favorites: number;
  readonly due: number;
}

export function bankOverview(bank: QuestionBank, p: Progress, now: number): BankOverview {
  let seen = 0, mastered = 0, attempts = 0, correct = 0, due = 0;
  for (const id of bank.allIds()) {
    const s = p.questions[id];
    if (!s) continue;
    seen++;
    attempts += s.attempts;
    correct += s.correct;
    if (isMastered(s)) mastered++;
    if (isDue(s, now)) due++;
  }
  return {
    total: bank.size,
    seen,
    mastered,
    attempts,
    correct,
    accuracy: attempts ? correct / attempts : 0,
    mistakes: p.mistakes.filter((id) => bank.has(id)).length,
    favorites: p.favorites.filter((id) => bank.has(id)).length,
    due,
  };
}

/** Общая точность ученика со сглаживанием Лапласа — априорная оценка для незнакомых вопросов. */
export function globalAccuracy(bank: QuestionBank, p: Progress): number {
  let attempts = 0, correct = 0;
  for (const id of bank.allIds()) {
    const s = p.questions[id];
    if (s) { attempts += s.attempts; correct += s.correct; }
  }
  return (correct + 1) / (attempts + 2);
}

/**
 * Оценка вероятности верного ответа на конкретный вопрос.
 * Сглаженная доля верных ответов с приором `prior` плюс дополнительный вес последнего ответа (недавнее знание важнее).
 */
export function questionEstimate(stat: QuestionStat | undefined, prior: number): number {
  if (!stat) return prior * UNSEEN_FACTOR;
  return (stat.correct + prior + (stat.lastCorrect ? 1 : 0)) / (stat.attempts + 2);
}

export function blockEstimates(bank: QuestionBank, p: Progress): number[] {
  const prior = globalAccuracy(bank, p);
  return Array.from({ length: BLOCKS_PER_TICKET }, (_, i) => {
    const ids = bank.blockIds(i + 1);
    if (ids.length === 0) return 0;
    return ids.reduce((sum, id) => sum + questionEstimate(p.questions[id], prior), 0) / ids.length;
  });
}

function binomial(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * Точная вероятность сдать экзамен при известной вероятности верного ответа в каждом блоке
 * (в предположении независимости ответов). Динамика по числу ошибок: в блоке допускается до
 * maxErrorsPerBlock ошибок, каждая влечёт extraQuestionsPerError дополнительных вопросов того же блока,
 * которые нужно решить без ошибок; всего ошибок — не более maxErrors.
 */
export function passProbability(blockP: readonly number[], rules: ExamRules = GIBDD_EXAM_RULES): number {
  const n = QUESTIONS_PER_BLOCK;
  let dp = [1];
  for (const raw of blockP) {
    const p = Math.min(1, Math.max(0, raw));
    const next = new Array<number>(dp.length + rules.maxErrorsPerBlock).fill(0);
    for (let e = 0; e <= Math.min(rules.maxErrorsPerBlock, n); e++) {
      const w = binomial(n, e) * p ** (n - e) * (1 - p) ** e * p ** (rules.extraQuestionsPerError * e);
      dp.forEach((v, k) => { next[k + e] = (next[k + e] ?? 0) + v * w; });
    }
    dp = next;
  }
  return dp.slice(0, rules.maxErrors + 1).reduce((a, b) => a + b, 0);
}

export type ReadinessLevel = 'low' | 'medium' | 'good' | 'ready';

export interface Readiness {
  readonly probability: number;
  readonly level: ReadinessLevel;
  readonly blocks: readonly number[];
}

export function readiness(bank: QuestionBank, p: Progress, rules: ExamRules = GIBDD_EXAM_RULES): Readiness {
  const blocks = blockEstimates(bank, p);
  const probability = passProbability(blocks, rules);
  const level: ReadinessLevel =
    probability >= 0.9 ? 'ready' : probability >= 0.7 ? 'good' : probability >= 0.3 ? 'medium' : 'low';
  return { probability, level, blocks };
}

export interface TopicMastery {
  readonly topicId: string;
  readonly title: string;
  readonly total: number;
  readonly seen: number;
  readonly mastered: number;
  /** Сглаженная точность по теме, 0..1 (0.5 без данных). */
  readonly accuracy: number;
}

export function topicMastery(bank: QuestionBank, p: Progress): TopicMastery[] {
  return bank.topics.map((t) => {
    const ids = bank.topicIds(t.id);
    let seen = 0, mastered = 0, attempts = 0, correct = 0;
    for (const id of ids) {
      const s = p.questions[id];
      if (!s) continue;
      seen++;
      attempts += s.attempts;
      correct += s.correct;
      if (isMastered(s)) mastered++;
    }
    return { topicId: t.id, title: t.title, total: ids.length, seen, mastered, accuracy: (correct + 1) / (attempts + 2) };
  });
}

export type TicketStatus = 'new' | 'perfect' | 'passed' | 'failed';

export interface TicketInfo {
  readonly number: number;
  readonly status: TicketStatus;
  readonly attempts: number;
  readonly lastErrors?: number;
}

/** Статус билета по последней попытке: 0 ошибок — «идеально», до 2 — «сдан бы», иначе — «не сдан». */
export function ticketStatuses(bank: QuestionBank, p: Progress): TicketInfo[] {
  return bank.tickets.map((t) => {
    const r = p.tickets[ticketKey(bank.id, t.number)];
    if (!r) return { number: t.number, status: 'new', attempts: 0 };
    const status: TicketStatus = r.lastErrors === 0 ? 'perfect' : r.lastErrors <= 2 ? 'passed' : 'failed';
    return { number: t.number, status, attempts: r.attempts, lastErrors: r.lastErrors };
  });
}

/** Самые «трудные» для ученика вопросы: доля ошибок со сглаживанием, при равенстве — больше ошибок. */
export function hardQuestions(bank: QuestionBank, p: Progress, limit: number): string[] {
  return bank.allIds()
    .map((id) => ({ id, s: p.questions[id] }))
    .filter((x): x is { id: string; s: QuestionStat } => x.s !== undefined && x.s.correct < x.s.attempts)
    .map(({ id, s }) => ({ id, rate: (s.attempts - s.correct + 1) / (s.attempts + 2), wrong: s.attempts - s.correct }))
    .sort((a, b) => b.rate - a.rate || b.wrong - a.wrong)
    .slice(0, limit)
    .map((x) => x.id);
}

/** Очередь интервального повторения: вопросы, срок которых наступил, — самые просроченные первыми. */
export function dueQuestions(bank: QuestionBank, p: Progress, now: number): string[] {
  return bank.allIds()
    .filter((id) => isDue(p.questions[id], now))
    .sort((a, b) => (p.questions[a]?.dueAt ?? 0) - (p.questions[b]?.dueAt ?? 0));
}

/** Серия дней подряд с занятиями. Сегодняшний день без занятий серию ещё не обрывает. */
export function currentStreak(activity: Readonly<Record<string, number>>, now: number): number {
  // Полдень предыдущего дня — устойчиво к переходу на летнее/зимнее время.
  const prevDay = (ts: number) => {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12).getTime();
  };
  let cursor = activity[dayKey(now)] ? now : prevDay(now);
  let streak = 0;
  while ((activity[dayKey(cursor)] ?? 0) > 0) {
    streak++;
    cursor = prevDay(cursor);
  }
  return streak;
}

export function answersToday(p: Progress, now: number): number {
  return p.activity[dayKey(now)] ?? 0;
}

export interface ExamStats {
  readonly total: number;
  readonly passed: number;
  /** Доля сданных среди последних 10 экзаменов. */
  readonly recentPassRate: number;
}

export function examStats(p: Progress, bankId: string): ExamStats {
  const exams = p.exams.filter((e) => e.bankId === bankId);
  const recent = exams.slice(-10);
  return {
    total: exams.length,
    passed: exams.filter((e) => e.passed).length,
    recentPassRate: recent.length ? recent.filter((e) => e.passed).length / recent.length : 0,
  };
}
