import { buildSmartSet } from '../core/adaptive.ts';
import { parseExamDate, studyPlan } from '../core/plan.ts';
import {
  type ExamAnswerOutcome, type ExamState, GIBDD_EXAM_RULES,
  abandonExam, answerExam, createExam, goToExamItem, skipExamQuestion, tickExam,
} from '../core/exam.ts';
import {
  type Progress, ProgressFormatError, emptyProgress, examRecord, mergeProgress, parseProgress,
  recordAnswer, recordExam, recordTicket, toggleFavorite,
} from '../core/progress.ts';
import { QuestionBank } from '../core/question-bank.ts';
import { createRng, randomSeed, shuffle } from '../core/rng.ts';
import {
  type AnswerOutcome, type PracticeMode, type PracticeState,
  advancePractice, answerPractice, createPractice, finishPractice, goToItem, summarizePractice,
} from '../core/session.ts';
import {
  answersToday, bankOverview, currentStreak, dueQuestions, examStats, hardQuestions,
  readiness, slowQuestions, ticketStatuses, timeStats, topicMastery,
} from '../core/stats.ts';
import { type BankId, type ContentPack, DomainError } from '../core/types.ts';
import { type TicketSet, categoryInfo, isBankId, isCategoryCode, ticketSet } from '../content/categories.ts';
import { DEMO_PACK } from '../content/demo-bank.ts';
import { parsePack } from '../content/pack-io.ts';
import { type Clock, type KeyValueStore, randomId } from './ports.ts';

export type Theme = 'auto' | 'light' | 'dark';

export interface Settings {
  /** Комплект билетов: AB (билеты ABM — A, B, M, A1, B1) или CD (C, D, C1, D1). */
  readonly bank: BankId;
  /** Показывать правильный ответ и пояснение сразу после ответа (кроме экзамена). */
  readonly instantFeedback: boolean;
  /** Перемешивать варианты ответов в тренировках. */
  readonly shuffleOptions: boolean;
  readonly dailyGoal: number;
  readonly theme: Theme;
  /** Прерывать экзамен в момент провала, как в ГИБДД. */
  readonly examFailFast: boolean;
  /** Дата экзамена (YYYY-MM-DD) для плана подготовки; null — не задана. */
  readonly examDate: string | null;
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  bank: 'AB',
  instantFeedback: true,
  shuffleOptions: false,
  dailyGoal: 40,
  theme: 'auto',
  examFailFast: true,
  examDate: null,
});

export type ActiveSession = PracticeState | ExamState;

const KEYS = {
  settings: 'pdd.v1.settings',
  progress: 'pdd.v1.progress',
  session: 'pdd.v1.session',
  pack: 'pdd.v1.pack',
} as const;

const SMART_SET_SIZE = 20;
const HARD_SET_SIZE = 30;

export interface TrainerDeps {
  readonly store: KeyValueStore;
  readonly clock: Clock;
  readonly seed?: () => number;
  readonly newId?: () => string;
  /** Контент по умолчанию (если пользователь не загрузил свой банк). */
  readonly defaultPack?: ContentPack;
}

/**
 * Прикладной сервис тренажёра: связывает чистое ядро с хранилищем и часами.
 * UI вызывает только этот сервис и подписывается на изменения.
 */
export class TrainerService {
  private readonly deps: Required<TrainerDeps>;
  private packValue: ContentPack;
  private settingsValue: Settings;
  private progressValue: Progress;
  private sessionValue: ActiveSession | null;
  private readonly banks = new Map<BankId, QuestionBank>();
  private readonly listeners = new Set<() => void>();
  /** Ошибки восстановления данных при запуске — показываются пользователю, а не теряются молча. */
  readonly warnings: string[] = [];

  constructor(deps: TrainerDeps) {
    this.deps = { seed: randomSeed, newId: randomId, defaultPack: DEMO_PACK, ...deps };
    this.packValue = this.loadPack();
    this.settingsValue = this.loadSettings();
    this.progressValue = this.loadProgress();
    this.sessionValue = this.loadSession();
  }

  // ---------- Подписка ----------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  // ---------- Состояние ----------

  get pack(): ContentPack { return this.packValue; }
  get settings(): Settings { return this.settingsValue; }
  get progress(): Progress { return this.progressValue; }
  get session(): ActiveSession | null { return this.sessionValue; }
  get ticketSet(): TicketSet { return ticketSet(this.settingsValue.bank); }
  get isCustomPack(): boolean { return this.packValue !== this.deps.defaultPack; }
  get isDemoPack(): boolean { return this.packValue === DEMO_PACK; }

  bankFor(id: BankId): QuestionBank {
    let bank = this.banks.get(id);
    if (!bank) {
      bank = new QuestionBank(this.packValue, id);
      this.banks.set(id, bank);
    }
    return bank;
  }

  get bank(): QuestionBank {
    return this.bankFor(this.settingsValue.bank);
  }

  /** Банк активной сессии (может отличаться от текущей категории, если категорию сменили во время сессии). */
  get sessionBank(): QuestionBank {
    return this.bankFor(this.sessionValue?.bankId ?? this.settingsValue.bank);
  }

  // ---------- Запуск режимов ----------

  startTicket(number: number): PracticeState {
    const ticket = this.bank.ticket(number);
    return this.startPractice('ticket', ticket.questionIds, `Билет ${number}`, { ticketNumber: number, shuffle: false });
  }

  startTopic(topicId: string): PracticeState {
    const ids = this.bank.topicIds(topicId);
    return this.startPractice('topic', ids, this.bank.topicTitle(topicId), { topicId });
  }

  startMarathon(): PracticeState {
    const rng = createRng(this.deps.seed());
    return this.startPractice('marathon', shuffle(this.bank.allIds(), rng), 'Марафон');
  }

  startMistakes(): PracticeState {
    const ids = this.progressValue.mistakes.filter((id) => this.bank.has(id));
    return this.startPractice('mistakes', ids, 'Работа над ошибками');
  }

  startFavorites(): PracticeState {
    const ids = this.progressValue.favorites.filter((id) => this.bank.has(id));
    return this.startPractice('favorites', ids, 'Избранное');
  }

  startHard(): PracticeState {
    return this.startPractice('hard', hardQuestions(this.bank, this.progressValue, HARD_SET_SIZE), 'Сложные вопросы');
  }

  startSmart(): PracticeState {
    const now = this.deps.clock.now();
    const ids = buildSmartSet(this.bank, this.progressValue, SMART_SET_SIZE, now, createRng(this.deps.seed()));
    return this.startPractice('smart', ids, 'Умная тренировка');
  }

  startReview(): PracticeState {
    const ids = dueQuestions(this.bank, this.progressValue, this.deps.clock.now()).slice(0, 50);
    return this.startPractice('review', ids, 'Повторение');
  }

  startSlow(): PracticeState {
    return this.startPractice('slow', slowQuestions(this.bank, this.progressValue, HARD_SET_SIZE), 'Медленные вопросы');
  }

  /** Частые ошибки учеников школы (список публикует автошкола). */
  startFrequent(ids: readonly string[]): PracticeState {
    return this.startPractice('frequent', ids.filter((id) => this.bank.has(id)), 'Частые ошибки учеников');
  }

  /** Следующий по порядку нерешённый билет (для плана подготовки). */
  startNextTicket(): PracticeState {
    const next = ticketStatuses(this.bank, this.progressValue).find((t) => t.status === 'new') ?? this.bank.tickets[0];
    if (!next) throw new DomainError('empty_session', 'В банке нет билетов');
    return this.startTicket(next.number);
  }

  startSearch(query: string): PracticeState {
    return this.startPractice('search', this.bank.search(query), `Поиск: ${query}`);
  }

  startQuestion(questionId: string): PracticeState {
    return this.startPractice('search', [questionId], 'Вопрос');
  }

  private startPractice(
    mode: PracticeMode,
    ids: readonly string[],
    title: string,
    opts: { ticketNumber?: number; topicId?: string; shuffle?: boolean } = {},
  ): PracticeState {
    if (ids.length === 0) throw new DomainError('empty_session', emptyMessage(mode));
    const state = createPractice({
      id: this.deps.newId(),
      mode,
      bank: this.bank,
      questionIds: ids,
      title,
      now: this.deps.clock.now(),
      rng: createRng(this.deps.seed()),
      shuffleOptions: opts.shuffle ?? this.settingsValue.shuffleOptions,
      ...(opts.ticketNumber !== undefined ? { ticketNumber: opts.ticketNumber } : {}),
      ...(opts.topicId !== undefined ? { topicId: opts.topicId } : {}),
    });
    this.setSession(state);
    return state;
  }

  startExam(): ExamState {
    const state = createExam(this.bank, {
      id: this.deps.newId(),
      now: this.deps.clock.now(),
      seed: this.deps.seed(),
      rules: { ...GIBDD_EXAM_RULES, failFast: this.settingsValue.examFailFast },
    });
    this.setSession(state);
    return state;
  }

  // ---------- Действия в сессии ----------

  answer(displayedIndex: number): AnswerOutcome | ExamAnswerOutcome | undefined {
    const s = this.requireSession();
    const now = this.deps.clock.now();
    const bank = this.sessionBank;
    if (s.kind === 'exam') {
      const { state, outcome } = answerExam(s, bank, s.cursor, displayedIndex, now);
      if (outcome) this.progressValue = recordAnswer(this.progressValue, outcome.questionId, outcome.correct, now, outcome.timeMs);
      // Остаёмся на отвеченном вопросе: к следующему переходит кнопка «Далее» (advance).
      this.afterExamChange(state.verdict === 'in_progress' ? { ...state, cursor: s.cursor } : state);
      return outcome;
    }
    const { state, outcome } = answerPractice(s, bank, s.cursor, displayedIndex, now);
    this.progressValue = recordAnswer(this.progressValue, outcome.questionId, outcome.correct, now, outcome.timeMs);
    if (outcome.finished && state.mode === 'ticket' && state.ticketNumber !== undefined) {
      const { wrong } = summarizePractice(state, now);
      this.progressValue = recordTicket(this.progressValue, state.bankId, state.ticketNumber, wrong, now);
    }
    this.saveProgress();
    this.setSession(state);
    return outcome;
  }

  /** «Далее»: следующий неотвеченный вопрос. */
  advance(): void {
    const s = this.requireSession();
    const now = this.deps.clock.now();
    this.setSession(s.kind === 'practice' ? advancePractice(s, now) : skipExamQuestion(s, now));
  }

  goTo(index: number): void {
    const s = this.requireSession();
    const now = this.deps.clock.now();
    this.setSession(s.kind === 'exam' ? goToExamItem(s, index, now) : goToItem(s, index, now));
  }

  skip(): void {
    this.advance();
  }

  /** Проверка таймера экзамена; возвращает true, если состояние изменилось. */
  tick(): boolean {
    const s = this.sessionValue;
    if (!s || s.kind !== 'exam' || s.verdict !== 'in_progress') return false;
    const next = tickExam(s, this.deps.clock.now());
    if (next === s) return false;
    this.afterExamChange(next);
    return true;
  }

  /** Досрочное завершение: экзамен считается не сданным, тренировка — завершённой. */
  finish(): void {
    const s = this.requireSession();
    const now = this.deps.clock.now();
    if (s.kind === 'exam') this.afterExamChange(abandonExam(s, now));
    else this.setSession(finishPractice(s, now));
  }

  closeSession(): void {
    this.setSession(null);
  }

  toggleFavorite(questionId: string): void {
    this.progressValue = toggleFavorite(this.progressValue, questionId, this.deps.clock.now());
    this.saveProgress();
    this.emit();
  }

  private afterExamChange(state: ExamState): void {
    if (state.verdict !== 'in_progress') {
      this.progressValue = recordExam(this.progressValue, examRecord(state), this.deps.clock.now());
    }
    this.saveProgress();
    this.setSession(state);
  }

  private requireSession(): ActiveSession {
    if (!this.sessionValue) throw new DomainError('no_session', 'Нет активной тренировки');
    return this.sessionValue;
  }

  private setSession(state: ActiveSession | null): void {
    this.sessionValue = state;
    if (state) this.deps.store.set(KEYS.session, JSON.stringify(state));
    else this.deps.store.remove(KEYS.session);
    this.emit();
  }

  // ---------- Аналитика ----------

  overview() {
    const now = this.deps.clock.now();
    const p = this.progressValue;
    const bank = this.bank;
    return {
      bank: bankOverview(bank, p, now),
      readiness: readiness(bank, p),
      streak: currentStreak(p.activity, now),
      today: answersToday(p, now),
      dailyGoal: this.settingsValue.dailyGoal,
      exams: examStats(p, bank.id),
      time: timeStats(bank, p),
      plan: this.plan(),
      topics: topicMastery(bank, p),
      tickets: ticketStatuses(bank, p),
      recentExams: p.exams.filter((e) => e.bankId === bank.id).slice(-10).reverse(),
    };
  }

  /** План подготовки к дате экзамена; null, если дата не задана. */
  plan() {
    const examAt = parseExamDate(this.settingsValue.examDate);
    if (examAt === null) return null;
    return studyPlan(examAt, ticketStatuses(this.bank, this.progressValue), this.progressValue.activity, this.deps.clock.now());
  }

  // ---------- Настройки и данные ----------

  updateSettings(patch: Partial<Settings>): void {
    this.settingsValue = sanitizeSettings({ ...this.settingsValue, ...patch });
    this.deps.store.set(KEYS.settings, JSON.stringify(this.settingsValue));
    this.emit();
  }

  exportData(): string {
    return JSON.stringify({ app: 'pdd-trainer', exportedAt: this.deps.clock.now(), progress: this.progressValue, settings: this.settingsValue }, null, 2);
  }

  /** Импорт прогресса сливается с текущим — данные не теряются. */
  importData(json: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      throw new ProgressFormatError('Файл не является корректным JSON');
    }
    const body = (raw as { progress?: unknown })?.progress ?? raw;
    this.progressValue = mergeProgress(this.progressValue, parseProgress(body));
    this.saveProgress();
    this.emit();
  }

  resetProgress(): void {
    this.progressValue = emptyProgress(this.deps.clock.now());
    this.saveProgress();
    this.setSession(null);
  }

  /** Загрузка собственного банка вопросов (например, импортированного официального). */
  loadCustomPack(json: string): ContentPack {
    const pack = parsePack(JSON.parse(json));
    this.deps.store.set(KEYS.pack, json);
    this.applyPack(pack);
    return pack;
  }

  resetPack(): void {
    this.deps.store.remove(KEYS.pack);
    this.applyPack(this.deps.defaultPack);
  }

  private applyPack(pack: ContentPack): void {
    this.packValue = pack;
    this.banks.clear();
    this.setSession(null);
  }

  // ---------- Загрузка из хранилища ----------

  private readJson(key: string): unknown {
    const raw = this.deps.store.get(key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      this.warnings.push(`Повреждённые данные (${key}) — сброшены`);
      this.deps.store.remove(key);
      return undefined;
    }
  }

  private loadPack(): ContentPack {
    const raw = this.readJson(KEYS.pack);
    if (raw === undefined) return this.deps.defaultPack;
    try {
      return parsePack(raw);
    } catch (e) {
      this.warnings.push(`Загруженный банк вопросов не прошёл проверку и отключён: ${(e as Error).message}`);
      this.deps.store.remove(KEYS.pack);
      return this.deps.defaultPack;
    }
  }

  private loadSettings(): Settings {
    const raw = this.readJson(KEYS.settings);
    const saved = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : {};
    // bank берётся только из сохранённых данных: иначе значение по умолчанию перекрыло бы старое поле category.
    return sanitizeSettings({ ...DEFAULT_SETTINGS, ...saved, bank: saved.bank });
  }

  private loadProgress(): Progress {
    const raw = this.readJson(KEYS.progress);
    if (raw === undefined) return emptyProgress(this.deps.clock.now());
    try {
      return parseProgress(raw);
    } catch (e) {
      this.warnings.push(`Прогресс не удалось прочитать: ${(e as Error).message}`);
      return emptyProgress(this.deps.clock.now());
    }
  }

  /** Сессия восстанавливается, только если все её вопросы есть в текущем банке. */
  private loadSession(): ActiveSession | null {
    const raw = this.readJson(KEYS.session) as ActiveSession | undefined;
    if (!raw || (raw.kind !== 'practice' && raw.kind !== 'exam') || !Array.isArray(raw.items)) return null;
    try {
      const bank = this.bankFor(raw.bankId);
      if (!raw.items.every((i) => bank.has(i.questionId))) return null;
      return raw;
    } catch {
      return null;
    }
  }

  private saveProgress(): void {
    this.deps.store.set(KEYS.progress, JSON.stringify(this.progressValue));
  }
}

function sanitizeSettings(s: Record<string, unknown>): Settings {
  const d = DEFAULT_SETTINGS;
  const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  return {
    // Настройки версии 1 хранили категорию; категории одного комплекта сдают одни и те же билеты.
    bank: isBankId(s.bank) ? s.bank : isCategoryCode(s.category) ? categoryInfo(s.category).bank : d.bank,
    instantFeedback: bool(s.instantFeedback, d.instantFeedback),
    shuffleOptions: bool(s.shuffleOptions, d.shuffleOptions),
    dailyGoal: typeof s.dailyGoal === 'number' && s.dailyGoal >= 5 && s.dailyGoal <= 500 ? Math.round(s.dailyGoal) : d.dailyGoal,
    theme: s.theme === 'light' || s.theme === 'dark' || s.theme === 'auto' ? s.theme : d.theme,
    examFailFast: bool(s.examFailFast, d.examFailFast),
    examDate: parseExamDate(typeof s.examDate === 'string' ? s.examDate : null) !== null ? (s.examDate as string) : null,
  };
}

function emptyMessage(mode: PracticeMode): string {
  switch (mode) {
    case 'mistakes': return 'Ошибок пока нет — отличная работа!';
    case 'favorites': return 'В избранном пока пусто. Отмечайте вопросы звёздочкой.';
    case 'hard': return 'Сложных вопросов пока нет: они появятся после первых ошибок.';
    case 'review': return 'Сейчас нечего повторять — загляните позже.';
    case 'search': return 'Ничего не найдено';
    case 'slow': return 'Медленных вопросов пока нет: они появятся, когда ответ займёт больше 45 секунд.';
    case 'frequent': return 'Автошкола ещё не опубликовала список частых ошибок.';
    default: return 'Нет вопросов для тренировки';
  }
}
