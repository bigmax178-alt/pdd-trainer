import {
  CredentialError, type Identity, type IssueInput, type Role, type SchoolConfig, type SealedSecret, type StaffKey,
  decodeInvite, importPrivateKey, issueAccount, keyMatches, openSecret, readToken, importPublicKey,
  sealSecret, staffFromInvite, verifyChain,
} from '../core/credentials.ts';
import { type VerifiedReport, decodeReport } from '../core/report.ts';
import type { Clock, KeyValueStore } from './ports.ts';

/** Учётная запись, сохранённая на устройстве. Ключ сотрудника хранится только зашифрованным паролем. */
type DeviceAccount =
  | { readonly kind: 'student'; readonly chain: readonly string[] }
  | { readonly kind: 'staff'; readonly role: 'admin' | 'manager'; readonly chain: readonly string[]; readonly sealed: SealedSecret };

/** Запись в журнале выданных доступов (хранится у того, кто выдал). */
export interface IssuedRecord {
  readonly id: string;
  readonly role: 'manager' | 'student';
  readonly name: string;
  readonly createdAt: number;
  readonly exp: number;
  readonly invite: string;
}

export interface InvitePreview {
  readonly identity: Identity;
  readonly staff: boolean;
}

const ACCOUNT_KEY = 'pdd.v1.account';
const issuedKey = (staffId: string) => `pdd.v1.issued.${staffId}`;
const reportsKey = (staffId: string) => `pdd.v1.reports.${staffId}`;
export const BACKUP_FORMAT = 'pdd-journal-backup';

/** Сохранённый отчёт ученика (последний от каждого). */
export interface StoredReport {
  readonly studentId: string;
  readonly name: string;
  readonly receivedAt: number;
  readonly report: VerifiedReport;
}

/** Зашифрованная резервная копия журнала и отчётов — паролем сотрудника. */
export interface JournalBackup {
  readonly format: typeof BACKUP_FORMAT;
  readonly v: 1;
  readonly staffId: string;
  readonly createdAt: number;
  readonly sealed: SealedSecret;
}
export const MIN_PASSWORD = 6;

export interface AccountDeps {
  readonly store: KeyValueStore;
  readonly clock: Clock;
  /** null — учётные записи не настроены (локальный файл, демо): тренажёр открыт всем. */
  readonly school: SchoolConfig | null;
  readonly pbkdf2Iterations?: number;
}

/**
 * Учётные записи на устройстве: вход по приглашению, разблокировка сотрудника паролем,
 * выдача доступов и журнал выданных. Сервер не нужен — проверка по подписям (core/credentials).
 */
export class AccountService {
  private readonly deps: AccountDeps;
  private identityValue: Identity | null = null;
  private staffValue: StaffKey | null = null;
  /** Почему сохранённый доступ не принят (истёк, заблокирован) — показывается на экране входа. */
  problem: string | null = null;

  constructor(deps: AccountDeps) {
    this.deps = deps;
  }

  get enabled(): boolean { return this.deps.school !== null; }
  get school(): SchoolConfig | null { return this.deps.school; }
  get identity(): Identity | null { return this.identityValue; }
  get role(): Role | null { return this.identityValue?.role ?? null; }
  get isStaff(): boolean { return this.role === 'admin' || this.role === 'manager'; }
  /** Сотрудник вошёл, но для выдачи доступов нужно ввести пароль. */
  get locked(): boolean { return this.isStaff && this.staffValue === null; }

  private now(): number {
    return Math.floor(this.deps.clock.now() / 1000);
  }

  private requireSchool(): SchoolConfig {
    if (!this.deps.school) throw new CredentialError('disabled', 'Учётные записи не настроены');
    return this.deps.school;
  }

  private readAccount(): DeviceAccount | null {
    const raw = this.deps.store.get(ACCOUNT_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DeviceAccount;
    } catch {
      return null;
    }
  }

  /** Восстановление входа при открытии сайта. Подписи проверяются заново каждый раз. */
  async restore(): Promise<Identity | null> {
    const school = this.deps.school;
    const acc = this.readAccount();
    if (!school || !acc) return null;
    try {
      if (acc.kind === 'student') {
        this.identityValue = await verifyChain(acc.chain, school, this.now());
      } else if (acc.role === 'admin') {
        this.identityValue = { role: 'admin', id: 'root', name: 'Администратор', exp: 0, chain: [] };
      } else {
        this.identityValue = await verifyChain(acc.chain, school, this.now());
      }
    } catch (e) {
      this.problem = (e as Error).message;
      this.identityValue = null;
    }
    return this.identityValue;
  }

  /** Разбор приглашения без входа: кому выдано и нужен ли пароль. */
  async previewInvite(text: string): Promise<InvitePreview> {
    const school = this.requireSchool();
    const invite = decodeInvite(text);
    if (invite.key) {
      const staff = await staffFromInvite(invite, school, this.now());
      return { identity: staff.identity, staff: true };
    }
    return { identity: await verifyChain(invite.chain, school, this.now()), staff: false };
  }

  /** Вход по приглашению. Сотрудник задаёт пароль — им шифруется ключ на этом устройстве. */
  async acceptInvite(text: string, password?: string): Promise<Identity> {
    const school = this.requireSchool();
    const invite = decodeInvite(text);
    let account: DeviceAccount;
    if (invite.key) {
      if (!password || password.length < MIN_PASSWORD) {
        throw new CredentialError('weak_password', `Придумайте пароль не короче ${MIN_PASSWORD} символов`);
      }
      const staff = await staffFromInvite(invite, school, this.now());
      const sealed = await sealSecret(invite.key, password, this.deps.pbkdf2Iterations);
      account = { kind: 'staff', role: staff.identity.role === 'admin' ? 'admin' : 'manager', chain: invite.chain, sealed };
      this.staffValue = staff;
      this.identityValue = staff.identity;
    } else {
      this.identityValue = await verifyChain(invite.chain, school, this.now());
      this.staffValue = null;
      account = { kind: 'student', chain: invite.chain };
    }
    this.problem = null;
    this.deps.store.set(ACCOUNT_KEY, JSON.stringify(account));
    return this.identityValue;
  }

  /** Разблокировка выдачи доступов паролем сотрудника. */
  async unlock(password: string): Promise<void> {
    const school = this.requireSchool();
    const acc = this.readAccount();
    if (!acc || acc.kind !== 'staff' || !this.identityValue) throw new CredentialError('not_staff', 'На этом устройстве нет учётной записи сотрудника');
    const d = await openSecret(acc.sealed, password);
    const pub = acc.role === 'admin'
      ? school.rootKey
      : (await readToken(acc.chain[0] as string, await importPublicKey(school.rootKey))).pub;
    if (!pub) throw new CredentialError('bad_key', 'Ключ сотрудника повреждён');
    const key = await importPrivateKey(d, pub);
    if (!(await keyMatches(key, pub))) throw new CredentialError('bad_key', 'Ключ сотрудника не подходит');
    this.staffValue = { identity: this.identityValue, key };
  }

  lock(): void {
    this.staffValue = null;
  }

  /** Выход с устройства. Повторный вход — по той же ссылке-приглашению. */
  logout(): void {
    this.deps.store.remove(ACCOUNT_KEY);
    this.identityValue = null;
    this.staffValue = null;
  }

  async issue(input: IssueInput): Promise<IssuedRecord> {
    if (!this.staffValue) throw new CredentialError('locked', 'Введите пароль, чтобы создавать учётные записи');
    const issued = await issueAccount(this.staffValue, input, this.now());
    const record: IssuedRecord = {
      id: issued.claim.id,
      role: issued.claim.role,
      name: issued.claim.name,
      createdAt: this.deps.clock.now(),
      exp: issued.claim.exp,
      invite: issued.invite,
    };
    const key = issuedKey(this.staffValue.identity.id);
    this.deps.store.set(key, JSON.stringify([record, ...this.issued()]));
    return record;
  }

  /** Журнал выданных доступов текущего сотрудника (на этом устройстве). */
  issued(): IssuedRecord[] {
    const id = this.identityValue?.id;
    if (!id) return [];
    try {
      const list = JSON.parse(this.deps.store.get(issuedKey(id)) ?? '[]') as unknown;
      return Array.isArray(list) ? (list as IssuedRecord[]) : [];
    } catch {
      return [];
    }
  }

  static inviteLink(base: string, invite: string): string {
    return `${base.replace(/#.*$/, '')}#invite=${invite}`;
  }

  static reportLink(base: string, code: string): string {
    return `${base.replace(/#.*$/, '')}#report=${code}`;
  }

  // ---------- Отчёты учеников ----------

  /** Проверка и сохранение отчёта (новый отчёт ученика заменяет прежний). Доступно сотруднику без пароля. */
  async receiveReport(text: string): Promise<StoredReport> {
    const school = this.requireSchool();
    const id = this.identityValue;
    if (!id || !this.isStaff) throw new CredentialError('not_staff', 'Отчёты принимают администратор и управляющий');
    const report = await decodeReport(text, school, this.now());
    const stored: StoredReport = { studentId: report.student.id, name: report.student.name, receivedAt: this.deps.clock.now(), report };
    const rest = this.reports().filter((r) => r.studentId !== stored.studentId);
    this.deps.store.set(reportsKey(id.id), JSON.stringify([stored, ...rest]));
    return stored;
  }

  reports(): StoredReport[] {
    const id = this.identityValue?.id;
    if (!id) return [];
    try {
      const list = JSON.parse(this.deps.store.get(reportsKey(id)) ?? '[]') as unknown;
      return Array.isArray(list) ? (list as StoredReport[]) : [];
    } catch {
      return [];
    }
  }

  // ---------- Резервная копия журнала ----------

  /** Журнал и отчёты, зашифрованные паролем сотрудника: файл можно хранить где угодно. */
  async exportJournal(password: string): Promise<JournalBackup> {
    const id = this.identityValue;
    if (!id || !this.isStaff) throw new CredentialError('not_staff', 'Резервная копия доступна только сотрудникам');
    await this.unlock(password); // проверка пароля
    const payload = JSON.stringify({ issued: this.issued(), reports: this.reports() });
    return {
      format: BACKUP_FORMAT, v: 1, staffId: id.id, createdAt: this.deps.clock.now(),
      sealed: await sealSecret(payload, password, this.deps.pbkdf2Iterations),
    };
  }

  /** Восстановление: записи объединяются с имеющимися (по id), ничего не затирается. */
  async importJournal(json: string, password: string): Promise<{ issued: number; reports: number }> {
    const id = this.identityValue;
    if (!id || !this.isStaff) throw new CredentialError('not_staff', 'Резервная копия доступна только сотрудникам');
    let backup: Partial<JournalBackup>;
    try {
      backup = JSON.parse(json) as Partial<JournalBackup>;
    } catch {
      throw new CredentialError('bad_backup', 'Это не файл резервной копии');
    }
    if (backup.format !== BACKUP_FORMAT || backup.v !== 1 || !backup.sealed) throw new CredentialError('bad_backup', 'Это не файл резервной копии');
    if (backup.staffId !== id.id) throw new CredentialError('bad_backup', 'Копия сделана другой учётной записью');
    const data = JSON.parse(await openSecret(backup.sealed, password)) as { issued?: IssuedRecord[]; reports?: StoredReport[] };
    const issued = mergeById(this.issued(), data.issued ?? [], (r) => r.id, (r) => r.createdAt);
    const reports = mergeById(this.reports(), data.reports ?? [], (r) => r.studentId, (r) => r.receivedAt);
    this.deps.store.set(issuedKey(id.id), JSON.stringify(issued));
    this.deps.store.set(reportsKey(id.id), JSON.stringify(reports));
    return { issued: issued.length, reports: reports.length };
  }
}

function mergeById<T>(mine: T[], theirs: T[], key: (r: T) => string, time: (r: T) => number): T[] {
  const map = new Map<string, T>();
  for (const r of [...theirs, ...mine]) {
    const prev = map.get(key(r));
    if (!prev || time(r) >= time(prev)) map.set(key(r), r);
  }
  return [...map.values()].sort((a, b) => time(b) - time(a));
}
