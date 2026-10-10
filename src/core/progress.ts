import type { ExamState, FailReason } from './exam.ts';
import { type SrsCard, scheduleCard } from './srs.ts';
import { type BankId, BANK_IDS } from './types.ts';

/**
 * Прогресс ученика. Хранится локально (офлайн-first) и синхронизируется с сервером.
 * Схема версионируется: parseProgress принимает любые данные (импорт файла, ответ сервера)
 * и возвращает валидную структуру либо бросает ProgressFormatError.
 */
export const PROGRESS_SCHEMA_VERSION = 1;
/** Сколько верных ответов подряд нужно, чтобы вопрос ушёл из «Работы над ошибками». */
export const MISTAKE_CLEAR_STREAK = 2;
export const MAX_EXAM_HISTORY = 100;

export interface QuestionStat extends SrsCard {
  readonly attempts: number;
  readonly correct: number;
  /** Верных ответов подряд (0 после ошибки). */
  readonly streak: number;
  readonly lastAt: number;
  readonly lastCorrect: boolean;
  /** Суммарное время размышлений над вопросом, мс (среднее = timeMs / attempts). */
  readonly timeMs: number;
}

export interface TicketResult {
  readonly attempts: number;
  readonly lastErrors: number;
  readonly bestErrors: number;
  readonly lastAt: number;
}

export interface ExamRecord {
  readonly id: string;
  readonly bankId: BankId;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly passed: boolean;
  readonly failReason?: FailReason;
  readonly total: number;
  readonly errors: number;
}

export interface Progress {
  readonly schemaVersion: number;
  readonly questions: Readonly<Record<string, QuestionStat>>;
  readonly mistakes: readonly string[];
  readonly favorites: readonly string[];
  /** Ключ — `${bankId}:${номер билета}`. */
  readonly tickets: Readonly<Record<string, TicketResult>>;
  readonly exams: readonly ExamRecord[];
  /** Количество ответов по дням, ключ — YYYY-MM-DD (локальная дата). */
  readonly activity: Readonly<Record<string, number>>;
  readonly updatedAt: number;
}

export class ProgressFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgressFormatError';
  }
}

export function emptyProgress(now: number): Progress {
  return {
    schemaVersion: PROGRESS_SCHEMA_VERSION,
    questions: {},
    mistakes: [],
    favorites: [],
    tickets: {},
    exams: [],
    activity: {},
    updatedAt: now,
  };
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function ticketKey(bankId: BankId, number: number): string {
  return `${bankId}:${number}`;
}

/** Больше этого времени на один ответ не учитывается: ученик явно отвлёкся. */
export const MAX_ANSWER_TIME_MS = 5 * 60_000;

export function recordAnswer(p: Progress, questionId: string, correct: boolean, now: number, timeMs = 0): Progress {
  const prev = p.questions[questionId];
  const card = scheduleCard(prev, correct, now);
  const stat: QuestionStat = {
    ...card,
    attempts: (prev?.attempts ?? 0) + 1,
    correct: (prev?.correct ?? 0) + (correct ? 1 : 0),
    streak: correct ? (prev?.streak ?? 0) + 1 : 0,
    lastAt: now,
    lastCorrect: correct,
    timeMs: (prev?.timeMs ?? 0) + Math.min(MAX_ANSWER_TIME_MS, Math.max(0, Math.round(timeMs))),
  };
  let mistakes = p.mistakes;
  if (!correct && !mistakes.includes(questionId)) mistakes = [...mistakes, questionId];
  if (correct && stat.streak >= MISTAKE_CLEAR_STREAK && mistakes.includes(questionId)) {
    mistakes = mistakes.filter((id) => id !== questionId);
  }
  const day = dayKey(now);
  return {
    ...p,
    questions: { ...p.questions, [questionId]: stat },
    mistakes,
    activity: { ...p.activity, [day]: (p.activity[day] ?? 0) + 1 },
    updatedAt: now,
  };
}

export function recordTicket(p: Progress, bankId: BankId, number: number, errors: number, now: number): Progress {
  const key = ticketKey(bankId, number);
  const prev = p.tickets[key];
  const result: TicketResult = {
    attempts: (prev?.attempts ?? 0) + 1,
    lastErrors: errors,
    bestErrors: Math.min(prev?.bestErrors ?? errors, errors),
    lastAt: now,
  };
  return { ...p, tickets: { ...p.tickets, [key]: result }, updatedAt: now };
}

export function examRecord(state: ExamState): ExamRecord {
  return {
    id: state.id,
    bankId: state.bankId,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt ?? state.deadline,
    passed: state.verdict === 'passed',
    ...(state.failReason !== undefined ? { failReason: state.failReason } : {}),
    total: state.items.length,
    errors: state.items.filter((i) => i.correct === false).length,
  };
}

export function recordExam(p: Progress, record: ExamRecord, now: number): Progress {
  if (p.exams.some((e) => e.id === record.id)) return p;
  return { ...p, exams: [...p.exams, record].slice(-MAX_EXAM_HISTORY), updatedAt: now };
}

export function toggleFavorite(p: Progress, questionId: string, now: number): Progress {
  const favorites = p.favorites.includes(questionId)
    ? p.favorites.filter((id) => id !== questionId)
    : [...p.favorites, questionId];
  return { ...p, favorites, updatedAt: now };
}

export function removeMistake(p: Progress, questionId: string, now: number): Progress {
  return { ...p, mistakes: p.mistakes.filter((id) => id !== questionId), updatedAt: now };
}

/**
 * Слияние двух версий прогресса (например, телефон и ноутбук были офлайн).
 * Операция коммутативна и идемпотентна (с точностью до порядка элементов списков):
 * merge(a, b) ≡ merge(b, a), merge(a, a) ≡ a. Это позволяет разрешать конфликты синхронизации без потерь.
 */
export function mergeProgress(a: Progress, b: Progress): Progress {
  const questions: Record<string, QuestionStat> = { ...a.questions };
  for (const [id, stat] of Object.entries(b.questions)) {
    const mine = questions[id];
    questions[id] = !mine || newer(stat, mine) ? stat : mine;
  }
  const tickets: Record<string, TicketResult> = { ...a.tickets };
  for (const [key, t] of Object.entries(b.tickets)) {
    const mine = tickets[key];
    tickets[key] = !mine ? t : {
      attempts: Math.max(mine.attempts, t.attempts),
      bestErrors: Math.min(mine.bestErrors, t.bestErrors),
      lastErrors: mine.lastAt === t.lastAt
        ? Math.min(mine.lastErrors, t.lastErrors)
        : (mine.lastAt > t.lastAt ? mine : t).lastErrors,
      lastAt: Math.max(mine.lastAt, t.lastAt),
    };
  }
  const activity: Record<string, number> = { ...a.activity };
  for (const [day, n] of Object.entries(b.activity)) activity[day] = Math.max(activity[day] ?? 0, n);

  const exams = new Map<string, ExamRecord>();
  for (const e of [...a.exams, ...b.exams]) exams.set(e.id, e);
  const sortedExams = [...exams.values()].sort((x, y) => x.finishedAt - y.finishedAt || x.id.localeCompare(y.id));

  const mistakes = union(a.mistakes, b.mistakes).filter((id) => (questions[id]?.streak ?? 0) < MISTAKE_CLEAR_STREAK);
  const favorites = a.updatedAt === b.updatedAt
    ? union(a.favorites, b.favorites)
    : (a.updatedAt > b.updatedAt ? a : b).favorites.slice();

  return {
    schemaVersion: PROGRESS_SCHEMA_VERSION,
    questions,
    mistakes,
    favorites,
    tickets,
    exams: sortedExams.slice(-MAX_EXAM_HISTORY),
    activity,
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

/** Порядок версий статистики вопроса: больше попыток → новее; при равенстве — по времени, затем по содержимому. */
function newer(x: QuestionStat, y: QuestionStat): boolean {
  if (x.attempts !== y.attempts) return x.attempts > y.attempts;
  if (x.lastAt !== y.lastAt) return x.lastAt > y.lastAt;
  return JSON.stringify(x) > JSON.stringify(y);
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

// ---------- Разбор и санитизация внешних данных ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const nonNeg = (v: unknown): number => Math.max(0, Math.floor(num(v)));
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 200))] : [];
const FAIL_REASONS: readonly FailReason[] = ['block_errors', 'total_errors', 'extra_error', 'timeout', 'abandoned'];

export function parseProgress(raw: unknown): Progress {
  if (!isObj(raw)) throw new ProgressFormatError('Файл прогресса повреждён: ожидался объект');
  const version = num(raw.schemaVersion, -1);
  if (version < 1) throw new ProgressFormatError('Неизвестный формат файла прогресса');
  if (version > PROGRESS_SCHEMA_VERSION) {
    throw new ProgressFormatError('Файл создан более новой версией приложения — обновите приложение');
  }

  const questions: Record<string, QuestionStat> = {};
  if (isObj(raw.questions)) {
    for (const [id, s] of Object.entries(raw.questions)) {
      if (!isObj(s)) continue;
      const attempts = nonNeg(s.attempts);
      if (attempts === 0) continue;
      questions[id] = {
        attempts,
        correct: Math.min(nonNeg(s.correct), attempts),
        streak: Math.min(nonNeg(s.streak), attempts),
        lastAt: nonNeg(s.lastAt),
        lastCorrect: s.lastCorrect === true,
        box: Math.min(nonNeg(s.box), 5),
        dueAt: nonNeg(s.dueAt),
        timeMs: nonNeg(s.timeMs),
      };
    }
  }

  const tickets: Record<string, TicketResult> = {};
  if (isObj(raw.tickets)) {
    for (const [key, t] of Object.entries(raw.tickets)) {
      if (!isObj(t) || !/^(AB|CD):\d+$/.test(key)) continue;
      tickets[key] = {
        attempts: Math.max(1, nonNeg(t.attempts)),
        lastErrors: nonNeg(t.lastErrors),
        bestErrors: nonNeg(t.bestErrors),
        lastAt: nonNeg(t.lastAt),
      };
    }
  }

  const exams: ExamRecord[] = [];
  if (Array.isArray(raw.exams)) {
    for (const e of raw.exams) {
      if (!isObj(e) || typeof e.id !== 'string' || !BANK_IDS.includes(e.bankId as BankId)) continue;
      const reason = FAIL_REASONS.find((r) => r === e.failReason);
      exams.push({
        id: e.id,
        bankId: e.bankId as BankId,
        startedAt: nonNeg(e.startedAt),
        finishedAt: nonNeg(e.finishedAt),
        passed: e.passed === true,
        ...(reason ? { failReason: reason } : {}),
        total: nonNeg(e.total),
        errors: nonNeg(e.errors),
      });
    }
  }

  const activity: Record<string, number> = {};
  if (isObj(raw.activity)) {
    for (const [day, n] of Object.entries(raw.activity)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) activity[day] = nonNeg(n);
    }
  }

  return {
    schemaVersion: PROGRESS_SCHEMA_VERSION,
    questions,
    mistakes: strArray(raw.mistakes),
    favorites: strArray(raw.favorites),
    tickets,
    exams: exams.slice(-MAX_EXAM_HISTORY),
    activity,
    updatedAt: nonNeg(raw.updatedAt),
  };
}
