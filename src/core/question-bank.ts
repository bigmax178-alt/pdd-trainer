import {
  type BankId,
  type ContentPack,
  type Question,
  type Ticket,
  type Topic,
  DomainError,
  blockOfPosition,
} from './types.ts';

/**
 * Индексированное представление одного банка билетов (AB или CD).
 * Строится один раз из ContentPack; все запросы — O(1) или O(k).
 */
export class QuestionBank {
  readonly id: BankId;
  readonly tickets: readonly Ticket[];
  readonly topics: readonly Topic[];
  private readonly questions = new Map<string, Question>();
  private readonly blocks = new Map<number, string[]>();
  private readonly topicIndex = new Map<string, string[]>();
  private readonly questionBlock = new Map<string, number>();
  private readonly orderedIds: string[] = [];

  constructor(pack: ContentPack, bankId: BankId) {
    this.id = bankId;
    this.tickets = [...pack.banks[bankId]].sort((a, b) => a.number - b.number);
    const pool = new Map(pack.questions.map((q) => [q.id, q]));

    for (const ticket of this.tickets) {
      ticket.questionIds.forEach((qid, position) => {
        const question = pool.get(qid);
        if (!question) {
          throw new DomainError('unknown_question', `Билет ${ticket.number} банка ${bankId} ссылается на неизвестный вопрос ${qid}`);
        }
        if (this.questions.has(qid)) return;
        this.questions.set(qid, question);
        this.orderedIds.push(qid);
        const block = blockOfPosition(position);
        this.questionBlock.set(qid, block);
        pushTo(this.blocks, block, qid);
        for (const topicId of question.topicIds) pushTo(this.topicIndex, topicId, qid);
      });
    }
    this.topics = pack.topics.filter((t) => this.topicIndex.has(t.id));
  }

  get size(): number {
    return this.orderedIds.length;
  }

  has(id: string): boolean {
    return this.questions.has(id);
  }

  get(id: string): Question {
    const q = this.questions.get(id);
    if (!q) throw new DomainError('unknown_question', `Вопрос ${id} отсутствует в банке ${this.id}`);
    return q;
  }

  ticket(number: number): Ticket {
    const t = this.tickets.find((x) => x.number === number);
    if (!t) throw new DomainError('unknown_ticket', `Билет ${number} отсутствует в банке ${this.id}`);
    return t;
  }

  /** Все вопросы банка в порядке билетов (без дублей). */
  allIds(): readonly string[] {
    return this.orderedIds;
  }

  /** Вопросы тематического блока 1..4 (по позиции в билете). */
  blockIds(block: number): readonly string[] {
    return this.blocks.get(block) ?? [];
  }

  /** Блок, в котором вопрос впервые встречается в билетах. */
  blockOf(id: string): number {
    const b = this.questionBlock.get(id);
    if (b === undefined) throw new DomainError('unknown_question', `Вопрос ${id} отсутствует в банке ${this.id}`);
    return b;
  }

  topicIds(topicId: string): readonly string[] {
    return this.topicIndex.get(topicId) ?? [];
  }

  topicTitle(topicId: string): string {
    return this.topics.find((t) => t.id === topicId)?.title ?? topicId;
  }

  /** Полнотекстовый поиск по тексту вопроса, вариантам и пояснению (регистронезависимо). */
  search(query: string, limit = 50): string[] {
    const terms = normalize(query).split(' ').filter((t) => t.length >= 2);
    if (terms.length === 0) return [];
    const out: string[] = [];
    for (const id of this.orderedIds) {
      const q = this.get(id);
      const haystack = normalize(`${q.text} ${q.options.join(' ')} ${q.explanation} ${(q.ruleRefs ?? []).join(' ')}`);
      if (terms.every((t) => haystack.includes(t))) {
        out.push(id);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /** Номер билета и позиция (1..20) первого вхождения вопроса — для отображения «Билет 3, вопрос 7». */
  locate(id: string): { ticket: number; position: number } | undefined {
    for (const t of this.tickets) {
      const idx = t.questionIds.indexOf(id);
      if (idx >= 0) return { ticket: t.number, position: idx + 1 };
    }
    return undefined;
  }
}

function pushTo<K>(map: Map<K, string[]>, key: K, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}.]+/gu, ' ').trim();
}
