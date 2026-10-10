import type { Progress } from './progress.ts';
import type { QuestionBank } from './question-bank.ts';
import type { Rng } from './rng.ts';
import { isDue, isMastered } from './srs.ts';
import { topicMastery } from './stats.ts';

export const SMART_WEIGHTS = Object.freeze({
  mistake: 6,
  due: 4,
  unseen: 3,
  /** Вес за слабость темы: base + weakTopic × (1 − точность темы). */
  base: 1,
  weakTopic: 4,
  masteredFactor: 0.25,
  recentFactor: 0.1,
  recentWindowMs: 10 * 60_000,
});

/** Вес вопроса в «умной тренировке»: чем выше, тем вероятнее он попадёт в подборку. */
export function smartWeight(
  id: string,
  bank: QuestionBank,
  p: Progress,
  topicAccuracy: ReadonlyMap<string, number>,
  now: number,
): number {
  const w = SMART_WEIGHTS;
  const stat = p.questions[id];
  const topics = bank.get(id).topicIds;
  const weakest = Math.min(...topics.map((t) => topicAccuracy.get(t) ?? 0.5));
  let weight = w.base + w.weakTopic * (1 - weakest);
  if (!stat) weight += w.unseen;
  if (p.mistakes.includes(id)) weight += w.mistake;
  if (isDue(stat, now)) weight += w.due;
  if (isMastered(stat) && !isDue(stat, now)) weight *= w.masteredFactor;
  if (stat && now - stat.lastAt < w.recentWindowMs) weight *= w.recentFactor;
  return weight;
}

/**
 * Адаптивная подборка вопросов: взвешенная выборка без возвращения (Efraimidis–Spirakis).
 * Ключ u^(1/w) даёт вероятность попадания, пропорциональную весу, за O(n log n).
 */
export function buildSmartSet(bank: QuestionBank, p: Progress, size: number, now: number, rng: Rng): string[] {
  const topicAccuracy = new Map(topicMastery(bank, p).map((t) => [t.topicId, t.accuracy]));
  return bank.allIds()
    .map((id) => ({ id, key: rng.next() ** (1 / smartWeight(id, bank, p, topicAccuracy, now)) }))
    .sort((a, b) => b.key - a.key)
    .slice(0, size)
    .map((x) => x.id);
}
