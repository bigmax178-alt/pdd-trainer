import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { QuestionBank } from '../src/core/question-bank.ts';
import { validatePack } from '../src/core/validation.ts';
import { CATEGORIES, TICKET_SETS, UNCONFIRMED_CATEGORIES, findTicketSet } from '../src/content/categories.ts';
import { DEMO_PACK } from '../src/content/demo-bank.ts';
import { PackFormatError, importExternalBank, parsePack } from '../src/content/pack-io.ts';
import { SIGNS, hasSign, parseSignCatalog, renderSign } from '../src/content/signs.ts';
import { TOPICS, topicIdFromTitle } from '../src/content/topics.ts';

describe('Демо-банк', () => {
  it('проходит валидацию без ошибок и предупреждений', () => {
    assert.deepEqual(validatePack(DEMO_PACK), []);
  });

  it('каждая категория прав ведёт в существующий банк, пригодный для экзамена', () => {
    assert.equal(CATEGORIES.length, 16);
    for (const c of CATEGORIES) assert.ok(new QuestionBank(DEMO_PACK, c.bank).tickets.length >= 2, c.code);
  });

  it('два комплекта билетов: A, B, M, A1, B1 — ABM; C, D, C1, D1 — CD; каждая категория ровно в одном', () => {
    assert.deepEqual(TICKET_SETS.map((t) => t.code), ['ABM', 'CD']);
    assert.deepEqual(findTicketSet('ABM')?.categories, ['A', 'B', 'M', 'A1', 'B1']);
    assert.deepEqual(findTicketSet('CD')?.categories, ['C', 'D', 'C1', 'D1']);
    for (const c of CATEGORIES) {
      const sets = TICKET_SETS.filter((t) => t.categories.includes(c.code));
      if (UNCONFIRMED_CATEGORIES.includes(c.code)) {
        assert.equal(sets.length, 0, `${c.code}: комплект не подтверждён — не показываем как официальный`);
        assert.equal(c.bankConfirmed, false);
      } else {
        assert.equal(sets.length, 1, c.code);
        assert.equal(sets[0]?.bank, c.bank);
      }
    }
  });

  it('все знаки из вопросов есть в векторной библиотеке, все темы используются', () => {
    for (const q of DEMO_PACK.questions) {
      if (q.image?.kind === 'signs') for (const s of q.image.signs) assert.ok(hasSign(s), `${q.id}: ${s}`);
    }
    const used = new Set(DEMO_PACK.questions.flatMap((q) => q.topicIds));
    for (const t of TOPICS) assert.ok(used.has(t.id), `тема ${t.id} без вопросов`);
  });

  it('правильный ответ не стоит всегда на одной позиции', () => {
    const positions = new Set(DEMO_PACK.questions.map((q) => q.correctIndex));
    assert.ok(positions.size >= 3);
  });
});

describe('Векторные знаки', () => {
  it('каждый знак рендерится в валидный SVG с подписью', () => {
    for (const s of SIGNS) {
      const svg = renderSign(s.code);
      assert.match(svg, /^<svg [^>]*viewBox="0 0 100 100"[^>]*>.*<\/svg>$/s);
      assert.match(svg, /aria-label="/);
    }
    assert.equal(new Set(SIGNS.map((s) => s.code)).size, SIGNS.length, 'коды уникальны');
  });

  it('значение на знаке экранируется (защита от XSS), неизвестный код — заглушка', () => {
    const svg = renderSign('3.24:<script>alert(1)</script>');
    assert.ok(!svg.includes('<script>'));
    assert.ok(svg.includes('&lt;script&gt;'));
    assert.match(renderSign('9.99'), /9\.99/);
  });
});

describe('Импорт официального банка (формат pdd_russia)', () => {
  const ticket = (n: number, mutate?: (q: Record<string, unknown>, pos: number) => void) =>
    Array.from({ length: 20 }, (_, i) => {
      const q: Record<string, unknown> = {
        title: `Вопрос ${i + 1}`,
        ticket_number: `Билет ${n}`,
        ticket_category: 'A,B',
        image: i === 0 ? './images/A_B/abc.jpg' : './images/no_image.jpg',
        question: `Текст вопроса ${i + 1} билета ${n}`,
        answers: [
          { answer_text: 'Первый', is_correct: false },
          { answer_text: 'Второй', is_correct: true },
          { answer_text: 'Третий', is_correct: false },
        ],
        correct_answer: 'Правильный ответ: 2',
        answer_tip: 'Согласно Пункту 10.2 ПДД и пункту 1.2.',
        topic: [i < 5 ? 'Общие положения' : 'Особая новая тема'],
        id: `id-${n}-${i}`,
      };
      mutate?.(q, i);
      return q;
    }).reverse(); // порядок в файле не важен — позиция берётся из title

  it('строит корректный пакет: позиции, правильные ответы, темы, картинки, ссылки на ПДД', () => {
    const { pack, issues } = importExternalBank({
      AB: [ticket(1), ticket(2)],
      CD: [ticket(1), ticket(2, (q, i) => { if (i === 3) q.question = 'Другой текст'; })],
      imageBaseUrl: 'https://cdn.example.org/pdd/',
    });
    assert.deepEqual(issues.filter((i) => i.level === 'error'), []);
    const ab1 = pack.banks.AB[0];
    assert.equal(ab1?.questionIds[0], 'id-1-0');
    const q = pack.questions.find((x) => x.id === 'id-1-0');
    assert.equal(q?.correctIndex, 1);
    assert.deepEqual(q?.ruleRefs, ['10.2', '1.2']);
    assert.deepEqual(q?.image, { kind: 'url', src: 'https://cdn.example.org/pdd/images/A_B/abc.jpg', alt: 'Иллюстрация к вопросу 1 билета 1' });
    assert.equal(q?.topicIds[0], 'general');
    assert.ok(pack.topics.some((t) => t.title === 'Особая новая тема'));
    assert.equal(pack.banks.CD[1]?.questionIds[3], 'id-2-3-CD', 'разный текст при одинаковом id разводится');
    assert.equal(pack.banks.CD[0]?.questionIds[3], 'id-1-3', 'одинаковые вопросы не дублируются');
    assert.doesNotThrow(() => parsePack(JSON.parse(JSON.stringify(pack))));
  });

  it('сообщает об ошибках исходных данных', () => {
    const { issues } = importExternalBank({
      AB: [ticket(1, (q, i) => { if (i === 2) q.answers = [{ answer_text: 'a', is_correct: true }, { answer_text: 'b', is_correct: true }]; }), 'мусор'],
      CD: [],
    });
    assert.ok(issues.some((i) => i.code === 'correct_count'));
    assert.ok(issues.some((i) => i.code === 'bad_ticket'));
    assert.ok(issues.some((i) => i.code === 'too_few_tickets'));
  });

  it('parsePack отвергает мусор и пакеты с ошибками', () => {
    assert.throws(() => parsePack(42), PackFormatError);
    assert.throws(() => parsePack({ questions: [], banks: { AB: [], CD: [] } }), PackFormatError);
    const broken = JSON.parse(JSON.stringify(DEMO_PACK));
    broken.questions[0].correctIndex = 7;
    assert.throws(() => parsePack(broken), /неверный индекс/);
    const evil = JSON.parse(JSON.stringify(DEMO_PACK));
    evil.questions[0].image = { kind: 'url', src: 'javascript:alert(1)' };
    assert.equal(parsePack(evil).questions[0]?.image, undefined, 'опасные URL картинок отбрасываются');
  });

  it('официальные формулировки тем сводятся к темам тренажёра', () => {
    assert.equal(topicIdFromTitle('Проезд перекрестков'), 'intersections', 'е вместо ё');
    assert.equal(topicIdFromTitle('Оказание доврачебной медицинской помощи'), 'firstaid');
    assert.equal(topicIdFromTitle('  Применение аварийной сигнализации и знака аварийной остановки '), 'hazard');
  });

  it('справочник знаков: только относительные пути к картинкам', () => {
    const groups = parseSignCatalog({ groups: [
      { group: 'Запрещающие', items: [
        { code: '3.1', title: 'Въезд запрещён', image: './images/signs/a1.svg', description: 'd' },
        { code: '3.2', title: 'x', image: 'javascript:alert(1)' },
        { code: '3.3', title: 'y', image: 'https://evil.example/x.svg' },
      ] },
      { group: 'Пустая', items: [] },
    ] });
    assert.deepEqual(groups.map((g) => g.items.map((i) => i.code)), [['3.1']]);
    assert.throws(() => parseSignCatalog({}));
  });

  it('транслитерация тем стабильна', () => {
    assert.equal(topicIdFromTitle('Скорость движения'), 'speed');
    assert.equal(topicIdFromTitle('Перевозка детей'), 't-perevozka-detey');
  });
});

describe('Архитектурные ограничения', () => {
  async function imports(dir: string): Promise<{ file: string; spec: string }[]> {
    const out: { file: string; spec: string }[] = [];
    for (const f of await readdir(dir, { recursive: true })) {
      if (!f.endsWith('.ts')) continue;
      const text = await readFile(join(dir, f), 'utf8');
      for (const m of text.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) out.push({ file: f, spec: m[1] as string });
    }
    return out;
  }
  const rules: { dir: string; forbid: RegExp; why: string }[] = [
    { dir: 'src/core', forbid: /^(?!\.\/)/, why: 'ядро не зависит ни от чего, кроме себя' },
    { dir: 'src/content', forbid: /^node:|\/(app|infra|web|server)\//, why: 'контент не зависит от инфраструктуры' },
    { dir: 'src/app', forbid: /^node:|\/(infra|web|server)\//, why: 'прикладной слой работает через порты' },
    { dir: 'src/web', forbid: /^node:|\/server\//, why: 'клиент не тянет серверный код' },
  ];
  for (const r of rules) {
    it(`${r.dir}: ${r.why}`, async () => {
      const bad = (await imports(r.dir)).filter((i) => r.forbid.test(i.spec));
      assert.deepEqual(bad, []);
    });
  }
});
