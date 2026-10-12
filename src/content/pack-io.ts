import { type ContentIssue, hasErrors, validatePack } from '../core/validation.ts';
import type { BankId, ContentPack, Question, QuestionImage, Ticket, Topic } from '../core/types.ts';
import { TOPICS, topicIdFromTitle } from './topics.ts';

export class PackFormatError extends Error {
  readonly issues: readonly ContentIssue[];
  constructor(message: string, issues: readonly ContentIssue[] = []) {
    super(message);
    this.name = 'PackFormatError';
    this.issues = issues;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function parseImage(v: unknown): QuestionImage | undefined {
  if (!isObj(v)) return undefined;
  if (v.kind === 'signs') return { kind: 'signs', signs: strings(v.signs) };
  if (v.kind === 'url' && /^(https?:\/\/|\.?\/|data:image\/)/.test(str(v.src))) {
    return { kind: 'url', src: str(v.src), ...(typeof v.alt === 'string' ? { alt: v.alt } : {}) };
  }
  return undefined;
}

/**
 * Разбор недоверенного JSON (файл, выбранный пользователем, или ответ сервера) в ContentPack.
 * Сначала структурная проверка типов, затем семантическая (validatePack). Ошибки → PackFormatError.
 */
export function parsePack(raw: unknown): ContentPack {
  if (!isObj(raw) || !Array.isArray(raw.questions) || !isObj(raw.banks)) {
    throw new PackFormatError('Файл не похож на банк вопросов: нужны поля questions и banks');
  }
  const questions: Question[] = raw.questions.filter(isObj).map((q) => {
    const image = parseImage(q.image);
    const refs = strings(q.ruleRefs);
    return {
      id: str(q.id),
      text: str(q.text),
      options: strings(q.options),
      correctIndex: typeof q.correctIndex === 'number' ? q.correctIndex : -1,
      explanation: str(q.explanation),
      topicIds: strings(q.topicIds),
      ...(image ? { image } : {}),
      ...(refs.length ? { ruleRefs: refs } : {}),
    };
  });
  const tickets = (v: unknown): Ticket[] =>
    Array.isArray(v)
      ? v.filter(isObj).map((t) => ({ number: typeof t.number === 'number' ? t.number : 0, questionIds: strings(t.questionIds) }))
      : [];
  const topics: Topic[] = Array.isArray(raw.topics)
    ? raw.topics.filter(isObj).map((t) => ({ id: str(t.id), title: str(t.title) })).filter((t) => t.id && t.title)
    : [...TOPICS];
  const pack: ContentPack = {
    version: str(raw.version) || 'custom',
    title: str(raw.title) || 'Пользовательский банк',
    topics,
    questions,
    banks: { AB: tickets(raw.banks.AB), CD: tickets(raw.banks.CD) },
  };
  const issues = validatePack(pack);
  if (hasErrors(issues)) {
    const first = issues.filter((i) => i.level === 'error').slice(0, 3).map((i) => i.message).join('; ');
    throw new PackFormatError(`Банк вопросов содержит ошибки: ${first}`, issues);
  }
  return pack;
}

// ---------- Импорт из открытого формата (репозиторий etspring/pdd_russia) ----------

/** Элемент файла «Билет N.json» в формате pdd_russia. */
interface ExternalQuestion {
  title?: unknown;
  ticket_number?: unknown;
  image?: unknown;
  question?: unknown;
  answers?: unknown;
  answer_tip?: unknown;
  topic?: unknown;
  id?: unknown;
}

export interface ExternalBankInput {
  /** Содержимое файлов билетов: массив билетов, каждый — массив из 20 вопросов. */
  readonly AB: readonly unknown[];
  readonly CD: readonly unknown[];
  /** База для относительных путей картинок, например https://example.org/pdd/ */
  readonly imageBaseUrl?: string;
  readonly version?: string;
}

const firstInt = (v: unknown): number | undefined => {
  const m = /\d+/.exec(str(v));
  return m ? Number(m[0]) : undefined;
};

export function importExternalBank(input: ExternalBankInput): { pack: ContentPack; issues: ContentIssue[] } {
  const issues: ContentIssue[] = [];
  const topics = new Map<string, Topic>(TOPICS.map((t) => [t.id, t]));
  const questions = new Map<string, Question>();
  const banks: Record<BankId, Ticket[]> = { AB: [], CD: [] };

  for (const bank of ['AB', 'CD'] as const) {
    input[bank].forEach((rawTicket, ticketIdx) => {
      if (!Array.isArray(rawTicket)) {
        issues.push({ level: 'error', code: 'bad_ticket', message: `Банк ${bank}: билет №${ticketIdx + 1} не является массивом` });
        return;
      }
      const items = rawTicket.filter(isObj) as ExternalQuestion[];
      const number = firstInt(items[0]?.ticket_number) ?? ticketIdx + 1;
      const ordered = items
        .map((q, i) => ({ q, pos: firstInt(q.title) ?? i + 1 }))
        .sort((a, b) => a.pos - b.pos);
      const ids: string[] = [];
      for (const { q, pos } of ordered) {
        const answers = Array.isArray(q.answers) ? q.answers.filter(isObj) : [];
        const options = answers.map((a) => str(a.answer_text).trim());
        const correct = answers.map((a, i) => (a.is_correct === true ? i : -1)).filter((i) => i >= 0);
        const where = `Банк ${bank}, билет ${number}, вопрос ${pos}`;
        if (correct.length !== 1) {
          issues.push({ level: 'error', code: 'correct_count', message: `${where}: правильных ответов ${correct.length}, ожидался 1` });
        }
        const topicIds = (Array.isArray(q.topic) ? strings(q.topic) : [str(q.topic)]).filter(Boolean).map((title) => {
          const id = topicIdFromTitle(title);
          if (!topics.has(id)) topics.set(id, { id, title: title.trim() });
          return id;
        });
        const imagePath = str(q.image);
        const image: QuestionImage | undefined = imagePath && !/no_image/i.test(imagePath)
          ? { kind: 'url', src: (input.imageBaseUrl ?? '') + imagePath.replace(/^\.\//, ''), alt: `Иллюстрация к вопросу ${pos} билета ${number}` }
          : undefined;
        const tip = str(q.answer_tip).trim();
        const refs = [...tip.matchAll(/[Пп]ункт[а-я]*\s+((?:\d+\.)*\d+)/g)].map((m) => m[1] as string);
        const question: Question = {
          id: '',
          text: str(q.question).trim(),
          options,
          correctIndex: correct[0] ?? -1,
          explanation: tip,
          topicIds: topicIds.length ? topicIds : ['general'],
          ...(image ? { image } : {}),
          ...(refs.length ? { ruleRefs: [...new Set(refs)] } : {}),
        };
        // Одинаковый id с разным содержимым разводим: сначала суффиксом банка (разные банки),
        // затем номером билета и вопроса — в исходном наборе id повторяется и внутри одного банка.
        const base = str(q.id) || `${bank.toLowerCase()}${number}-${pos}`;
        const taken = (candidate: string) => {
          const existing = questions.get(candidate);
          return existing !== undefined && JSON.stringify({ ...existing, id: '' }) !== JSON.stringify(question);
        };
        let id = base;
        if (taken(id)) id = `${base}-${bank}`;
        if (taken(id)) id = `${base}-${bank}-${number}-${pos}`;
        if (!questions.has(id)) questions.set(id, { ...question, id });
        ids.push(id);
      }
      banks[bank].push({ number, questionIds: ids });
    });
  }

  const pack: ContentPack = {
    version: input.version ?? `import-${new Date().toISOString().slice(0, 10)}`,
    title: 'Официальный банк билетов ПДД',
    topics: [...topics.values()],
    questions: [...questions.values()],
    banks,
  };
  return { pack, issues: [...issues, ...validatePack(pack)] };
}
