import { BANK_IDS, type ContentPack, QUESTIONS_PER_TICKET, blockOfPosition } from './types.ts';

export type IssueLevel = 'error' | 'warning';

export interface ContentIssue {
  readonly level: IssueLevel;
  readonly code: string;
  readonly message: string;
}

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
/** Для дополнительных вопросов экзамена нужен хотя бы один «запасной» билет. */
const MIN_TICKETS_FOR_EXAM = 2;

/**
 * Проверка целостности пакета контента. Ошибки блокируют загрузку пакета,
 * предупреждения — нет. Запускается на CI (`npm run validate:content`) и при импорте в приложении.
 */
export function validatePack(pack: ContentPack): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const err = (code: string, message: string) => issues.push({ level: 'error', code, message });
  const warn = (code: string, message: string) => issues.push({ level: 'warning', code, message });

  const topicIds = new Set<string>();
  for (const t of pack.topics) {
    if (topicIds.has(t.id)) err('duplicate_topic', `Тема ${t.id} объявлена дважды`);
    topicIds.add(t.id);
  }

  const questionIds = new Set<string>();
  for (const q of pack.questions) {
    const where = `Вопрос ${q.id}`;
    if (!q.id) err('empty_id', 'Вопрос без идентификатора');
    if (questionIds.has(q.id)) err('duplicate_question', `${where}: дублирующийся id`);
    questionIds.add(q.id);
    if (!q.text.trim()) err('empty_text', `${where}: пустой текст`);
    if (q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
      err('options_count', `${where}: вариантов ${q.options.length}, допустимо ${MIN_OPTIONS}–${MAX_OPTIONS}`);
    }
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.options.length) {
      err('correct_index', `${where}: неверный индекс правильного ответа ${q.correctIndex}`);
    }
    if (q.options.some((o) => !o.trim())) err('empty_option', `${where}: пустой вариант ответа`);
    if (new Set(q.options.map((o) => o.trim().toLowerCase())).size !== q.options.length) {
      err('duplicate_option', `${where}: повторяющиеся варианты ответа`);
    }
    if (q.topicIds.length === 0) err('no_topic', `${where}: не указана тема`);
    for (const t of q.topicIds) if (!topicIds.has(t)) err('unknown_topic', `${where}: неизвестная тема ${t}`);
    if (!q.explanation.trim()) warn('no_explanation', `${where}: нет пояснения`);
  }

  const used = new Set<string>();
  for (const bank of BANK_IDS) {
    const tickets = pack.banks[bank] ?? [];
    if (tickets.length < MIN_TICKETS_FOR_EXAM) {
      err('too_few_tickets', `Банк ${bank}: билетов ${tickets.length}, для экзамена нужно не менее ${MIN_TICKETS_FOR_EXAM}`);
    }
    const numbers = new Set<number>();
    const blockOf = new Map<string, number>();
    for (const ticket of tickets) {
      const where = `Банк ${bank}, билет ${ticket.number}`;
      if (numbers.has(ticket.number)) err('duplicate_ticket', `${where}: номер повторяется`);
      numbers.add(ticket.number);
      if (ticket.questionIds.length !== QUESTIONS_PER_TICKET) {
        err('ticket_size', `${where}: ${ticket.questionIds.length} вопросов вместо ${QUESTIONS_PER_TICKET}`);
      }
      if (new Set(ticket.questionIds).size !== ticket.questionIds.length) {
        err('duplicate_in_ticket', `${where}: вопрос повторяется внутри билета`);
      }
      ticket.questionIds.forEach((qid, pos) => {
        used.add(qid);
        if (!questionIds.has(qid)) err('unknown_question', `${where}: неизвестный вопрос ${qid}`);
        const block = blockOfPosition(pos);
        const prev = blockOf.get(qid);
        if (prev !== undefined && prev !== block) {
          warn('block_mismatch', `${where}: вопрос ${qid} стоит в блоке ${block}, а в другом билете — в блоке ${prev}`);
        }
        blockOf.set(qid, block);
      });
    }
  }
  for (const id of questionIds) if (!used.has(id)) warn('orphan_question', `Вопрос ${id} не входит ни в один билет`);

  return issues;
}

export function hasErrors(issues: readonly ContentIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}
