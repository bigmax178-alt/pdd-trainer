import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AccountService } from '../src/app/accounts.ts';
import { TrainerService } from '../src/app/trainer.ts';
import { type SchoolConfig, encodeInvite, generateKeyPair, staffFromInvite, decodeInvite, issueAccount } from '../src/core/credentials.ts';
import { daysUntil, parseExamDate, studyPlan } from '../src/core/plan.ts';
import { emptyProgress, recordAnswer, recordTicket } from '../src/core/progress.ts';
import { QuestionBank } from '../src/core/question-bank.ts';
import { decodeReport, encodeReport, frequentMistakes, type StudentReport } from '../src/core/report.ts';
import { SimilarityIndex, stems } from '../src/core/similar.ts';
import { slowQuestions, ticketStatuses, timeStats } from '../src/core/stats.ts';
import { RuleIndex, parseRuleBook } from '../src/content/rules.ts';
import { TIPS } from '../src/content/tips.ts';
import { TOPICS } from '../src/content/topics.ts';
import { DEMO_PACK } from '../src/content/demo-bank.ts';
import { MemoryStore } from '../src/infra/stores.ts';
import { DAY, FakeClock, T0, right, syntheticPack, wrong } from './fixtures.ts';

const bank = new QuestionBank(DEMO_PACK, 'AB');
const NOW = Math.floor(T0 / 1000);

describe('Время на вопрос', () => {
  it('учитывается от показа вопроса до ответа и копится в прогрессе', () => {
    const clock = new FakeClock();
    const svc = new TrainerService({ store: new MemoryStore(), clock, seed: () => 1 });
    svc.startTicket(1);
    clock.advance(12_000);
    const out = svc.answer(right(svc.session!, svc.bank));
    assert.equal(out?.timeMs, 12_000);
    svc.advance();
    clock.advance(70_000);
    svc.answer(wrong(svc.session!, svc.bank));
    const ids = svc.session!.items.slice(0, 2).map((i) => i.questionId) as [string, string];
    assert.equal(svc.progress.questions[ids[0]]?.timeMs, 12_000);
    assert.equal(svc.progress.questions[ids[1]]?.timeMs, 70_000);
    assert.deepEqual(slowQuestions(svc.bank, svc.progress, 10), [ids[1]]);
    assert.equal(timeStats(svc.bank, svc.progress).slow, 1);
    assert.equal(timeStats(svc.bank, svc.progress).avgMs, 41_000);
  });

  it('пауза дольше 5 минут не засчитывается полностью', () => {
    const p = recordAnswer(emptyProgress(T0), 'q', true, T0, 20 * 60_000);
    assert.equal(p.questions.q?.timeMs, 5 * 60_000);
  });
});

describe('План подготовки к экзамену', () => {
  const tickets = ticketStatuses(bank, recordTicket(emptyProgress(T0), 'AB', 1, 0, T0));

  it('даты: разбор и дни до экзамена', () => {
    assert.equal(parseExamDate('2026-13-01'), null);
    assert.equal(parseExamDate('2026-02-30'), null);
    assert.equal(parseExamDate('мусор'), null);
    assert.equal(parseExamDate(null), null);
    const exam = parseExamDate('2026-10-20')!;
    assert.equal(daysUntil(exam, new Date(2026, 9, 10, 23, 59).getTime()), 10, 'считаются календарные дни');
  });

  it('темп и статус', () => {
    const exam = parseExamDate('2026-10-20')!;
    const now = new Date(2026, 9, 10, 12).getTime();
    const behind = studyPlan(exam, tickets, {}, now);
    assert.deepEqual([behind.unsolved, behind.perDay, behind.status], [2, 1, 'behind']);
    const activity: Record<string, number> = {};
    for (let i = 1; i <= 7; i++) {
      const d = new Date(now - i * DAY);
      activity[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`] = 40;
    }
    assert.equal(studyPlan(exam, tickets, activity, now).status, 'on_track');
    assert.equal(studyPlan(exam, tickets, {}, now + 30 * DAY).status, 'past');
    const all = ticketStatuses(bank, [1, 2, 3].reduce((p, n) => recordTicket(p, 'AB', n, 0, T0), emptyProgress(T0)));
    assert.equal(studyPlan(exam, all, {}, now).status, 'done');
  });

  it('дата экзамена хранится в настройках, мусор отбрасывается', () => {
    const svc = new TrainerService({ store: new MemoryStore(), clock: new FakeClock() });
    svc.updateSettings({ examDate: '2026-12-01' });
    assert.ok(svc.plan());
    svc.updateSettings({ examDate: 'x' });
    assert.equal(svc.settings.examDate, null);
  });
});

describe('Похожие вопросы', () => {
  it('основы слов и сходство: тот же знак — похожие вопросы, разные темы — нет', () => {
    assert.deepEqual([...stems('Разрешён ли Вам поворот направо?')], ['разре', 'повор', 'напра']);
    const index = new SimilarityIndex(bank);
    const forStop = index.similar('ab2-02'); // знак 3.27 «Остановка запрещена»
    assert.ok(forStop.some((s) => s.id === 'ab2-03'), 'знак 3.28 рядом');
    assert.ok(!index.similar('ab1-20').some((s) => s.id === 'ab1-09'), 'первая помощь и скорость не похожи');
    for (const id of bank.allIds()) assert.ok(!index.similar(id).some((s) => s.id === id));
  });
});

describe('Текст ПДД', () => {
  const book = parseRuleBook({ source: 's', edition: 'e', sections: [
    { num: '13', title: 'Проезд перекрёстков', items: [{ num: '13.11', text: 'Помеха справа.' }, { num: '13.11.1', text: 'Круг.' }] },
    { num: '2', title: 'Обязанности', items: [{ num: '2.1', text: 'Иметь при себе документы.' }] },
    { num: '', title: 'пусто', items: [] },
  ] });

  it('поиск пункта с откатом к родительскому', () => {
    const idx = new RuleIndex(book);
    assert.equal(book.sections.length, 2);
    assert.equal(idx.find('13.11')?.item.text, 'Помеха справа.');
    assert.equal(idx.find('2.1.1')?.item.num, '2.1', 'подпункт → родитель');
    assert.equal(idx.find('99.1'), undefined);
    assert.throws(() => parseRuleBook({}));
  });

  it('шпаргалки ссылаются на существующие темы', () => {
    const topicIds = new Set(TOPICS.map((t) => t.id));
    for (const t of TIPS) assert.ok(topicIds.has(t.topicId), t.topicId);
    assert.ok(TIPS.length >= 12);
  });
});

describe('Отчёты учеников', () => {
  async function school() {
    const root = await generateKeyPair();
    const cfg: SchoolConfig = { name: 'Светофор', rootKey: root.publicKey, revoked: [] };
    const admin = await staffFromInvite(decodeInvite(encodeInvite([], root.privateKey)), cfg, NOW);
    return { cfg, admin, root };
  }
  const stats = (mistakes: string[]) => ({
    bank: 'AB' as const, seen: 100, total: 800, accuracy: 0.9, probability: 0.55, ticketsSolved: 5, ticketsPerfect: 2, ticketsTotal: 40,
    examsTotal: 2, examsPassed: 1, streak: 3, avgTimeMs: 30_000, mistakes,
  });

  it('личность подтверждается цепочкой, чужие и сотрудники отклоняются, цифры санитизируются', async () => {
    const { cfg, admin } = await school();
    const st = await issueAccount(admin, { role: 'student', name: 'Иванов Иван', months: 6 }, NOW);
    const report: StudentReport = { v: 1, at: T0, chain: st.chain, stats: { ...stats(['ab1-01']), probability: 7 } as never };
    const v = await decodeReport(`https://site/#report=${encodeReport(report)}`, cfg, NOW + 1);
    assert.equal(v.student.name, 'Иванов Иван');
    assert.equal(v.stats.probability, 1, 'ограничено сверху');
    const mgr = await issueAccount(admin, { role: 'manager', name: 'Петров Пётр', months: 6 }, NOW);
    await assert.rejects(decodeReport(encodeReport({ ...report, chain: mgr.chain }), cfg, NOW + 1), /только ученик/);
    const other = await school();
    await assert.rejects(decodeReport(encodeReport(report), other.cfg, NOW + 1), /не выдано/);
    await assert.rejects(decodeReport('мусор', cfg, NOW + 1), /не отчёт/);
  });

  it('управляющий сохраняет отчёты и видит частые ошибки', async () => {
    const { cfg, admin } = await school();
    const clock = new FakeClock();
    const svc = new AccountService({ store: new MemoryStore(), clock, school: cfg, pbkdf2Iterations: 1000 });
    const mgr = await issueAccount(admin, { role: 'manager', name: 'Петров Пётр', months: 6 }, NOW);
    await svc.acceptInvite(mgr.invite, 'пароль-123');
    const a = await issueAccount(admin, { role: 'student', name: 'Иванов', months: 6 }, NOW);
    const b = await issueAccount(admin, { role: 'student', name: 'Сидоров', months: 6 }, NOW);
    await svc.receiveReport(encodeReport({ v: 1, at: T0, chain: a.chain, stats: stats(['q1', 'q2']) }));
    await svc.receiveReport(encodeReport({ v: 1, at: T0 + 1, chain: b.chain, stats: stats(['q2', 'q3']) }));
    await svc.receiveReport(encodeReport({ v: 1, at: T0 + 2, chain: a.chain, stats: stats(['q2', 'q3']) }));
    assert.equal(svc.reports().length, 2, 'новый отчёт ученика заменяет прежний');
    assert.deepEqual(frequentMistakes(svc.reports().map((r) => r.report)), [{ id: 'q2', students: 2 }, { id: 'q3', students: 2 }]);
  });

  it('резервная копия журнала: зашифрована паролем, восстанавливается с объединением', async () => {
    const { cfg, admin } = await school();
    const clock = new FakeClock();
    const svc = new AccountService({ store: new MemoryStore(), clock, school: cfg, pbkdf2Iterations: 1000 });
    const mgr = await issueAccount(admin, { role: 'manager', name: 'Петров Пётр', months: 6 }, NOW);
    await svc.acceptInvite(mgr.invite, 'пароль-123');
    const s1 = await svc.issue({ role: 'student', name: 'Первый Ученик', months: 3 });
    const backup = JSON.stringify(await svc.exportJournal('пароль-123'));
    assert.ok(!backup.includes(s1.invite), 'копия не содержит приглашений открытым текстом');
    await assert.rejects(svc.exportJournal('не тот'), /Неверный пароль/);

    const fresh = new AccountService({ store: new MemoryStore(), clock, school: cfg, pbkdf2Iterations: 1000 });
    await fresh.acceptInvite(mgr.invite, 'пароль-123');
    await fresh.issue({ role: 'student', name: 'Второй Ученик', months: 3 });
    await assert.rejects(fresh.importJournal(backup, 'не тот'), /Неверный пароль/);
    const res = await fresh.importJournal(backup, 'пароль-123');
    assert.equal(res.issued, 2);
    assert.deepEqual(fresh.issued().map((r) => r.name).sort(), ['Второй Ученик', 'Первый Ученик']);
    await assert.rejects(fresh.importJournal('{}', 'пароль-123'), /не файл резервной копии/);
  });
});

describe('Синтетический банк для похожих вопросов', () => {
  it('одинаковые формулировки соседних билетов считаются похожими', () => {
    const synth = new QuestionBank(syntheticPack(3), 'AB');
    const index = new SimilarityIndex(synth);
    assert.ok(index.similar('q1-0').length > 0);
  });
});
