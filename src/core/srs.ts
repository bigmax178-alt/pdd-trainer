/**
 * Интервальное повторение по системе Лейтнера.
 * Коробка 0 — вопрос ещё не встречался. Верный ответ переносит вопрос в следующую коробку,
 * ошибка — обратно в первую. Чем выше коробка, тем реже вопрос возвращается на повторение.
 */
export const LEITNER_INTERVALS_DAYS: readonly number[] = [0, 1, 3, 7, 14, 30];
export const MAX_BOX = LEITNER_INTERVALS_DAYS.length - 1;
export const DAY_MS = 86_400_000;

export interface SrsCard {
  readonly box: number;
  readonly dueAt: number;
}

export function scheduleCard(card: SrsCard | undefined, correct: boolean, now: number): SrsCard {
  const box = correct ? Math.min((card?.box ?? 0) + 1, MAX_BOX) : 1;
  return { box, dueAt: now + (LEITNER_INTERVALS_DAYS[box] ?? 0) * DAY_MS };
}

export function isDue(card: SrsCard | undefined, now: number): boolean {
  return card !== undefined && card.box > 0 && card.dueAt <= now;
}

/** Вопрос считается выученным с 4-й коробки (верно отвечен несколько раз с растущими интервалами). */
export function isMastered(card: SrsCard | undefined): boolean {
  return card !== undefined && card.box >= 4;
}
