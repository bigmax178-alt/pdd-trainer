import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ExamState } from '../core/exam.ts';
import type { Progress } from '../core/progress.ts';

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly createdAt: number;
}

export interface ProgressRecord {
  readonly progress: Progress;
  /** Монотонная ревизия для оптимистичной блокировки (ETag / If-Match). */
  readonly revision: number;
}

export interface ExamRecordRow {
  readonly userId: string;
  readonly state: ExamState;
}

/**
 * Порт хранилища. Асинхронный, чтобы адаптер PostgreSQL подключался без изменения API-слоя.
 */
export interface Repository {
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  findUserById(id: string): Promise<UserRecord | undefined>;
  /** false — пользователь с таким email уже существует. */
  createUser(user: UserRecord): Promise<boolean>;
  getProgress(userId: string): Promise<ProgressRecord | undefined>;
  /** Сохраняет, только если текущая ревизия равна ожидаемой; иначе возвращает 'conflict'. */
  saveProgress(userId: string, progress: Progress, expectedRevision: number): Promise<ProgressRecord | 'conflict'>;
  getExam(id: string): Promise<ExamRecordRow | undefined>;
  saveExam(id: string, row: ExamRecordRow): Promise<void>;
  close(): Promise<void>;
}

interface Snapshot {
  users: UserRecord[];
  progress: Record<string, ProgressRecord>;
  exams: Record<string, ExamRecordRow>;
}

export class MemoryRepository implements Repository {
  protected users = new Map<string, UserRecord>();
  protected byEmail = new Map<string, string>();
  protected progress = new Map<string, ProgressRecord>();
  protected exams = new Map<string, ExamRecordRow>();

  async findUserByEmail(email: string) {
    const id = this.byEmail.get(email.toLowerCase());
    return id ? this.users.get(id) : undefined;
  }
  async findUserById(id: string) {
    return this.users.get(id);
  }
  async createUser(user: UserRecord) {
    const key = user.email.toLowerCase();
    if (this.byEmail.has(key)) return false;
    this.users.set(user.id, user);
    this.byEmail.set(key, user.id);
    this.changed();
    return true;
  }
  async getProgress(userId: string) {
    return this.progress.get(userId);
  }
  async saveProgress(userId: string, progress: Progress, expectedRevision: number) {
    const current = this.progress.get(userId)?.revision ?? 0;
    if (current !== expectedRevision) return 'conflict' as const;
    const record = { progress, revision: current + 1 };
    this.progress.set(userId, record);
    this.changed();
    return record;
  }
  async getExam(id: string) {
    return this.exams.get(id);
  }
  async saveExam(id: string, row: ExamRecordRow) {
    this.exams.set(id, row);
    this.changed();
  }
  async close() {}

  protected changed(): void {}

  protected snapshot(): Snapshot {
    return {
      users: [...this.users.values()],
      progress: Object.fromEntries(this.progress),
      exams: Object.fromEntries(this.exams),
    };
  }

  protected restore(s: Snapshot): void {
    for (const u of s.users ?? []) {
      this.users.set(u.id, u);
      this.byEmail.set(u.email.toLowerCase(), u.id);
    }
    this.progress = new Map(Object.entries(s.progress ?? {}));
    this.exams = new Map(Object.entries(s.exams ?? {}));
  }
}

/**
 * Файловый адаптер для одного инстанса: состояние в памяти, на диск — атомарно (temp + rename)
 * с объединением частых записей. Для нескольких инстансов используется адаптер БД.
 */
export class FileRepository extends MemoryRepository {
  private readonly path: string;
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();

  private constructor(path: string) {
    super();
    this.path = path;
  }

  static async open(path: string): Promise<FileRepository> {
    const repo = new FileRepository(path);
    try {
      repo.restore(JSON.parse(await readFile(path, 'utf8')) as Snapshot);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return repo;
  }

  protected override changed(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 200);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    const data = JSON.stringify(this.snapshot());
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, this.path);
    });
    return this.writing;
  }

  override async close(): Promise<void> {
    await this.flush();
  }
}
