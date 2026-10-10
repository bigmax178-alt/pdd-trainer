/**
 * Доменные типы тренажёра. Модуль не содержит логики и не зависит ни от чего.
 * Все структуры — неизменяемые и сериализуемые в JSON (хранятся в localStorage / на сервере).
 */

/** Банк экзаменационных билетов. В РФ их два: «AB» (A, B, M и подкатегории) и «CD» (C, D, E-комбинации, Tm, Tb). */
export type BankId = 'AB' | 'CD';

export const BANK_IDS: readonly BankId[] = ['AB', 'CD'];

export type CategoryCode =
  | 'M' | 'A' | 'A1' | 'B' | 'B1' | 'BE'
  | 'C' | 'C1' | 'CE' | 'C1E'
  | 'D' | 'D1' | 'DE' | 'D1E'
  | 'Tm' | 'Tb';

/** Изображение к вопросу: либо набор знаков, которые рисуются векторно, либо внешняя картинка. */
export type QuestionImage =
  | { readonly kind: 'signs'; readonly signs: readonly string[] }
  | { readonly kind: 'url'; readonly src: string; readonly alt?: string };

export interface Question {
  readonly id: string;
  readonly text: string;
  readonly options: readonly string[];
  readonly correctIndex: number;
  readonly explanation: string;
  readonly topicIds: readonly string[];
  readonly image?: QuestionImage;
  /** Ссылки на пункты ПДД, например ["10.2"]. */
  readonly ruleRefs?: readonly string[];
}

/** Билет: 20 вопросов, позиции 1–5, 6–10, 11–15, 16–20 образуют 4 тематических блока. */
export interface Ticket {
  readonly number: number;
  readonly questionIds: readonly string[];
}

export interface Topic {
  readonly id: string;
  readonly title: string;
}

/** Пакет контента: общий пул вопросов + билеты обоих банков. Версионируется независимо от кода. */
export interface ContentPack {
  readonly version: string;
  readonly title: string;
  readonly topics: readonly Topic[];
  readonly questions: readonly Question[];
  readonly banks: Readonly<Record<BankId, readonly Ticket[]>>;
}

export const QUESTIONS_PER_TICKET = 20;
export const QUESTIONS_PER_BLOCK = 5;
export const BLOCKS_PER_TICKET = 4;

/** Номер тематического блока (1..4) по позиции вопроса в билете (0..19). */
export function blockOfPosition(position: number): number {
  return Math.floor(position / QUESTIONS_PER_BLOCK) + 1;
}

/** Ошибка домена: нарушение инварианта или недопустимая операция. */
export class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
