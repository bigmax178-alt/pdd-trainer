import { dayKey } from './progress.ts';
import type { TicketInfo } from './stats.ts';

/**
 * План подготовки к дате экзамена: сколько билетов решать в день, чтобы пройти все до экзамена,
 * и успевает ли ученик при текущем темпе.
 */
export interface StudyPlan {
  readonly daysLeft: number;
  /** Билеты, которые ещё не решались. */
  readonly unsolved: number;
  /** Билеты, решённые с ошибками (по последней попытке). */
  readonly weak: number;
  /** Сколько билетов в день нужно, чтобы решить все нерешённые (0 — всё решено). */
  readonly perDay: number;
  /** Средний темп за последние 7 дней, билетов в день (20 ответов ≈ 1 билет). */
  readonly pace: number;
  readonly status: 'done' | 'on_track' | 'behind' | 'past';
}

export const ANSWERS_PER_TICKET = 20;

/** Разбор даты формы YYYY-MM-DD в полдень локального времени; null для мусора. */
export function parseExamDate(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d, 12);
  return date.getMonth() === m - 1 && date.getDate() === d ? date.getTime() : null;
}

export function daysUntil(examAt: number, now: number): number {
  const a = new Date(now), b = new Date(examAt);
  const start = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const end = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((end - start) / 86_400_000);
}

export function studyPlan(
  examAt: number,
  tickets: readonly TicketInfo[],
  activity: Readonly<Record<string, number>>,
  now: number,
): StudyPlan {
  const daysLeft = daysUntil(examAt, now);
  const unsolved = tickets.filter((t) => t.status === 'new').length;
  const weak = tickets.filter((t) => t.status === 'failed' || t.status === 'passed').length;
  let answers = 0;
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now);
    answers += activity[dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i, 12).getTime())] ?? 0;
  }
  const pace = answers / 7 / ANSWERS_PER_TICKET;
  const perDay = unsolved === 0 ? 0 : Math.ceil(unsolved / Math.max(1, daysLeft));
  const status: StudyPlan['status'] =
    daysLeft < 0 ? 'past' : unsolved === 0 ? 'done' : pace >= perDay - 1e-9 ? 'on_track' : 'behind';
  return { daysLeft, unsolved, weak, perDay, pace, status };
}
