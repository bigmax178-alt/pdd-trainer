import type { QuestionBank } from './question-bank.ts';

/**
 * Похожие вопросы: в билетах много «близнецов» — та же картинка перекрёстка, другой манёвр,
 * или та же формулировка с другим числом. Показ похожих вопросов рядом учит правилу, а не картинке.
 * Сходство = коэффициент Жаккара по словесным основам + бонус за одинаковую картинку.
 */
export interface SimilarQuestion {
  readonly id: string;
  readonly score: number;
}

const STOP = new Set(['этом', 'этой', 'этого', 'данной', 'данном', 'случае', 'случаях', 'разрешается', 'разрешено', 'запрещается',
  'запрещено', 'можно', 'нужно', 'должен', 'должны', 'обязан', 'обязаны', 'только', 'также', 'либо', 'если', 'который', 'которые',
  'перечисленных', 'обоих', 'всех', 'какие', 'какой', 'каком', 'какая', 'вам', 'вы', 'при', 'для', 'или', 'что', 'как', 'его', 'ваш']);

/** Основа слова: строчные, ё→е, первые 5 букв (грубый стемминг достаточен для сравнения формулировок). */
export function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(/^\d/.test(w) ? w : w.slice(0, 5));
  }
  return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export const SIMILARITY_THRESHOLD = 0.3;
export const SAME_IMAGE_BONUS = 0.5;

export class SimilarityIndex {
  private readonly bank: QuestionBank;
  private readonly tokens = new Map<string, Set<string>>();
  private readonly byImage = new Map<string, string[]>();

  constructor(bank: QuestionBank) {
    this.bank = bank;
    for (const id of bank.allIds()) {
      const q = bank.get(id);
      this.tokens.set(id, stems(`${q.text} ${q.options.join(' ')}`));
      const img = q.image?.kind === 'url' ? q.image.src : undefined;
      if (img) this.byImage.set(img, [...(this.byImage.get(img) ?? []), id]);
    }
  }

  /** До `limit` самых похожих вопросов с оценкой ≥ порога, без самого вопроса. */
  similar(id: string, limit = 3): SimilarQuestion[] {
    const mine = this.tokens.get(id);
    if (!mine) return [];
    const q = this.bank.get(id);
    const img = q.image?.kind === 'url' ? q.image.src : undefined;
    const sameImage = new Set(img ? this.byImage.get(img) ?? [] : []);
    const out: SimilarQuestion[] = [];
    for (const [other, toks] of this.tokens) {
      if (other === id) continue;
      const score = jaccard(mine, toks) + (sameImage.has(other) ? SAME_IMAGE_BONUS : 0);
      if (score >= SIMILARITY_THRESHOLD) out.push({ id: other, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
