import { CredentialError, type Identity, type SchoolConfig, b64urlDecode, b64urlEncode, verifyChain } from './credentials.ts';
import type { BankId } from './types.ts';

/**
 * Отчёт ученика для автошколы. Сервера нет, поэтому отчёт — это ссылка, которую ученик отправляет
 * управляющему сам. Личность подтверждается цепочкой удостоверений (подпись автошколы),
 * а цифры берутся с устройства ученика — подделать их он может, подменить личность — нет.
 */
export interface ReportStats {
  readonly bank: BankId;
  readonly seen: number;
  readonly total: number;
  readonly accuracy: number;
  readonly probability: number;
  readonly ticketsSolved: number;
  readonly ticketsPerfect: number;
  readonly ticketsTotal: number;
  readonly examsTotal: number;
  readonly examsPassed: number;
  readonly streak: number;
  readonly avgTimeMs: number;
  /** Вопросы из «Работы над ошибками» (до MAX_REPORT_MISTAKES) — для сводки частых ошибок по школе. */
  readonly mistakes: readonly string[];
}

export interface StudentReport {
  readonly v: 1;
  readonly at: number;
  readonly chain: readonly string[];
  readonly stats: ReportStats;
}

export interface VerifiedReport {
  readonly student: Identity;
  readonly at: number;
  readonly stats: ReportStats;
}

export const MAX_REPORT_MISTAKES = 60;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeReport(report: StudentReport): string {
  return b64urlEncode(enc.encode(JSON.stringify(report)));
}

const num = (v: unknown, max = 1e9) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : 0);

/** Разбор и проверка отчёта: подпись цепочки, роль ученика, санитизация чисел. */
export async function decodeReport(text: string, school: SchoolConfig, nowSec: number): Promise<VerifiedReport> {
  const code = text.trim().replace(/^.*#report=/, '');
  let raw: Partial<StudentReport>;
  try {
    raw = JSON.parse(dec.decode(b64urlDecode(code))) as Partial<StudentReport>;
  } catch {
    throw new CredentialError('bad_report', 'Это не отчёт ученика');
  }
  if (raw.v !== 1 || !Array.isArray(raw.chain) || typeof raw.stats !== 'object' || !raw.stats) {
    throw new CredentialError('bad_report', 'Отчёт повреждён');
  }
  const student = await verifyChain(raw.chain.filter((x): x is string => typeof x === 'string'), school, nowSec);
  if (student.role !== 'student') throw new CredentialError('bad_report', 'Отчёт может прислать только ученик');
  const s = raw.stats as Partial<ReportStats>;
  const stats: ReportStats = {
    bank: s.bank === 'CD' ? 'CD' : 'AB',
    seen: num(s.seen), total: num(s.total), accuracy: num(s.accuracy, 1), probability: num(s.probability, 1),
    ticketsSolved: num(s.ticketsSolved), ticketsPerfect: num(s.ticketsPerfect), ticketsTotal: num(s.ticketsTotal),
    examsTotal: num(s.examsTotal), examsPassed: num(s.examsPassed), streak: num(s.streak), avgTimeMs: num(s.avgTimeMs),
    mistakes: Array.isArray(s.mistakes) ? s.mistakes.filter((x): x is string => typeof x === 'string').slice(0, MAX_REPORT_MISTAKES) : [],
  };
  return { student, at: num(raw.at), stats };
}

export interface FrequentMistake {
  readonly id: string;
  /** Сколько учеников ошибаются на этом вопросе. */
  readonly students: number;
}

/** Сводка по отчётам: вопросы, на которых ошибаются чаще всего (по числу учеников). */
export function frequentMistakes(reports: readonly { stats: { mistakes: readonly string[] } }[], minStudents = 2): FrequentMistake[] {
  const counts = new Map<string, number>();
  for (const r of reports) for (const id of new Set(r.stats.mistakes)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n >= minStudents)
    .map(([id, students]) => ({ id, students }))
    .sort((a, b) => b.students - a.students || a.id.localeCompare(b.id));
}
