import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AccountService } from '../src/app/accounts.ts';
import {
  type Claim, CredentialError, type SchoolConfig, decodeInvite, encodeInvite, generateKeyPair, importPrivateKey,
  issueAccount, normalizeName, openSecret, parseSchoolConfig, sealSecret, signClaim, staffFromInvite, verifyChain,
} from '../src/core/credentials.ts';
import { MemoryStore, PrefixedStore } from '../src/infra/stores.ts';
import { accountCard, adminView, emptyAccountUi, welcomeView } from '../src/web/views-accounts.ts';
import { DAY, FakeClock, T0 } from './fixtures.ts';

const NOW = Math.floor(T0 / 1000);
const code = (e: unknown) => (e as CredentialError).code;

async function makeSchool(revoked: string[] = []) {
  const root = await generateKeyPair();
  const school: SchoolConfig = { name: 'Автошкола «Светофор»', rootKey: root.publicKey, revoked };
  const admin = await staffFromInvite(decodeInvite(encodeInvite([], root.privateKey)), school, NOW);
  return { root, school, admin };
}

describe('Удостоверения: цепочка подписей', () => {
  it('администратор → управляющий → ученик; администратор → ученик', async () => {
    const { school, admin } = await makeSchool();
    const mgr = await issueAccount(admin, { role: 'manager', name: 'Петров Пётр', months: 12 }, NOW);
    const mgrStaff = await staffFromInvite(decodeInvite(mgr.invite), school, NOW);
    assert.equal(mgrStaff.identity.role, 'manager');
    const st = await issueAccount(mgrStaff, { role: 'student', name: '  Иванов   Иван ', months: 6 }, NOW);
    const id = await verifyChain(decodeInvite(st.invite).chain, school, NOW);
    assert.deepEqual([id.role, id.name, id.chain.length], ['student', 'Иванов Иван', 2]);
    const direct = await issueAccount(admin, { role: 'student', name: 'Сидорова Анна', months: 0 }, NOW);
    assert.equal((await verifyChain(direct.chain, school, NOW)).exp, 0, 'бессрочно');
    assert.equal(decodeInvite(st.invite).key, undefined, 'у ученика в ссылке нет ключа');
  });

  it('права ролей: управляющий не создаёт управляющих, ученик — никого', async () => {
    const { school, admin, root } = await makeSchool();
    const mgr = await issueAccount(admin, { role: 'manager', name: 'Петров Пётр', months: 12 }, NOW);
    const mgrStaff = await staffFromInvite(decodeInvite(mgr.invite), school, NOW);
    await assert.rejects(issueAccount(mgrStaff, { role: 'manager', name: 'Новый Управляющий', months: 1 }, NOW), (e) => code(e) === 'forbidden');
    // Подделка в обход интерфейса: управляющий сам подписывает «управляющего» — сайт не примет цепочку.
    const fake: Claim = { v: 1, id: 'fake-mgr', role: 'manager', name: 'Самозванец', iss: mgrStaff.identity.id, iat: NOW, exp: 0, pub: root.publicKey };
    const forged = [...mgrStaff.identity.chain, await signClaim(fake, mgrStaff.key)];
    await assert.rejects(verifyChain(forged, school, NOW), (e) => code(e) === 'forbidden');
    const st = { identity: { role: 'student' as const, id: 's', name: 's', exp: 0, chain: [] }, key: mgrStaff.key };
    await assert.rejects(issueAccount(st, { role: 'student', name: 'Кто-то', months: 1 }, NOW), (e) => code(e) === 'forbidden');
  });

  it('подделка и чужой ключ отклоняются', async () => {
    const { school, admin } = await makeSchool();
    const other = await makeSchool();
    const st = await issueAccount(other.admin, { role: 'student', name: 'Чужой Ученик', months: 6 }, NOW);
    await assert.rejects(verifyChain(st.chain, school, NOW), (e) => code(e) === 'bad_signature');
    const mine = await issueAccount(admin, { role: 'student', name: 'Свой Ученик', months: 6 }, NOW);
    const [body, sig] = (mine.chain[0] as string).split('.');
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body as string, 'base64url').toString()), exp: 0 })).toString('base64url');
    await assert.rejects(verifyChain([`${tampered}.${sig}`], school, NOW), (e) => code(e) === 'bad_signature');
    await assert.rejects(staffFromInvite(decodeInvite(encodeInvite([], (await generateKeyPair()).privateKey)), school, NOW),
      (e) => code(e) === 'bad_key');
  });

  it('сроки и блокировки: срок не дольше, чем у выдавшего; блокировка управляющего закрывает его учеников', async () => {
    const { school, admin } = await makeSchool();
    const mgr = await issueAccount(admin, { role: 'manager', name: 'Петров Пётр', months: 3 }, NOW);
    const mgrStaff = await staffFromInvite(decodeInvite(mgr.invite), school, NOW);
    const st = await issueAccount(mgrStaff, { role: 'student', name: 'Иванов Иван', months: 12 }, NOW);
    assert.equal(st.claim.exp, mgr.claim.exp, 'доступ ученика ограничен сроком управляющего');
    assert.equal(new Date(mgr.claim.exp * 1000).getMonth(), (new Date(T0).getMonth() + 3) % 12, 'срок в календарных месяцах');
    await assert.rejects(verifyChain(st.chain, school, mgr.claim.exp + 1), (e) => code(e) === 'expired');
    const revoked = { ...school, revoked: [mgr.claim.id] };
    await assert.rejects(verifyChain(st.chain, revoked, NOW), (e) => code(e) === 'revoked');
  });

  it('приглашения, имена, настройки школы', async () => {
    assert.throws(() => decodeInvite('https://example.org/#invite=привет'), CredentialError);
    assert.throws(() => decodeInvite('root'), CredentialError);
    assert.deepEqual(decodeInvite('https://site/#invite=a.b~c.d'), { chain: ['a.b', 'c.d'] });
    assert.equal(normalizeName('<b>Иван</b>\n Петров'), 'bИван/b Петров');
    const { school } = await makeSchool();
    assert.deepEqual(parseSchoolConfig(JSON.parse(JSON.stringify(school))), school);
    assert.throws(() => parseSchoolConfig({ name: 'x', rootKey: 'short' }), CredentialError);
    await assert.rejects(importPrivateKey('x', school.rootKey), CredentialError);
  });

  it('ключ на устройстве шифруется паролем', async () => {
    const sealed = await sealSecret('секрет', 'пароль-123', 1000);
    assert.equal(await openSecret(sealed, 'пароль-123'), 'секрет');
    await assert.rejects(openSecret(sealed, 'не тот'), (e) => code(e) === 'bad_password');
    assert.ok(!JSON.stringify(sealed).includes('секрет'));
  });
});

describe('Учётные записи на устройстве', () => {
  async function setup() {
    const { school, root } = await makeSchool();
    const store = new MemoryStore();
    const clock = new FakeClock();
    const svc = new AccountService({ store, clock, school, pbkdf2Iterations: 1000 });
    return { school, root, store, clock, svc, adminInvite: encodeInvite([], root.privateKey) };
  }

  it('администратор входит по ссылке, создаёт управляющего и ученика; журнал выданных', async () => {
    const { svc, adminInvite } = await setup();
    assert.equal((await svc.previewInvite(adminInvite)).staff, true);
    await assert.rejects(svc.acceptInvite(adminInvite, '123'), (e) => code(e) === 'weak_password');
    await svc.acceptInvite(adminInvite, 'надёжный-пароль');
    assert.equal(svc.role, 'admin');
    assert.equal(svc.locked, false);
    const mgr = await svc.issue({ role: 'manager', name: 'Петров Пётр', months: 12 });
    const st = await svc.issue({ role: 'student', name: 'Иванов Иван', months: 6 });
    assert.deepEqual(svc.issued().map((r) => r.name), ['Иванов Иван', 'Петров Пётр']);
    assert.match(AccountService.inviteLink('https://site/pdd/#home', st.invite), /^https:\/\/site\/pdd\/#invite=/);
    assert.equal((await svc.previewInvite(mgr.invite)).identity.role, 'manager');
  });

  it('после перезапуска: сотрудник заблокирован до пароля, ученик входит сам', async () => {
    const { svc, store, clock, school, adminInvite } = await setup();
    await svc.acceptInvite(adminInvite, 'надёжный-пароль');
    const st = await svc.issue({ role: 'student', name: 'Иванов Иван', months: 6 });

    const again = new AccountService({ store, clock, school, pbkdf2Iterations: 1000 });
    await again.restore();
    assert.equal(again.role, 'admin');
    assert.equal(again.locked, true);
    await assert.rejects(again.issue({ role: 'student', name: 'Кто-то', months: 1 }), (e) => code(e) === 'locked');
    await assert.rejects(again.unlock('неверный'), (e) => code(e) === 'bad_password');
    await again.unlock('надёжный-пароль');
    assert.equal(again.locked, false);

    const phoneStore = new MemoryStore();
    const phone = new AccountService({ store: phoneStore, clock, school });
    await phone.acceptInvite(st.invite);
    assert.equal(phone.role, 'student');
    assert.equal(phone.isStaff, false);
    clock.advance(400 * DAY);
    const later = new AccountService({ store: phoneStore, clock, school });
    assert.equal(await later.restore(), null);
    assert.match(later.problem ?? '', /Срок доступа истёк/);
  });

  it('управляющий может создавать только учеников; выход стирает вход', async () => {
    const { svc, school, clock, adminInvite } = await setup();
    await svc.acceptInvite(adminInvite, 'надёжный-пароль');
    const mgr = await svc.issue({ role: 'manager', name: 'Петров Пётр', months: 12 });
    const mgrDevice = new AccountService({ store: new MemoryStore(), clock, school, pbkdf2Iterations: 1000 });
    await mgrDevice.acceptInvite(mgr.invite, 'пароль-управляющего');
    await assert.rejects(mgrDevice.issue({ role: 'manager', name: 'Ещё Управляющий', months: 1 }), (e) => code(e) === 'forbidden');
    const st = await mgrDevice.issue({ role: 'student', name: 'Иванов Иван', months: 6 });
    assert.equal((await verifyChain(decodeInvite(st.invite).chain, school, NOW)).role, 'student');
    mgrDevice.logout();
    assert.equal(mgrDevice.identity, null);
  });

  it('прогресс разных пользователей на одном устройстве не смешивается', () => {
    const base = new MemoryStore();
    new PrefixedStore(base, 'pdd.u.a.').set('pdd.v1.progress', '1');
    new PrefixedStore(base, 'pdd.u.b.').set('pdd.v1.progress', '2');
    assert.equal(new PrefixedStore(base, 'pdd.u.a.').get('pdd.v1.progress'), '1');
    assert.equal(base.get('pdd.v1.progress'), null);
  });

  it('экраны: вход, подтверждение, управление; имена экранируются', async () => {
    const { svc, school, clock, adminInvite } = await setup();
    const ui = emptyAccountUi();
    assert.match(welcomeView(svc, ui).value, /id="invite-form"/);
    ui.preview = await svc.previewInvite(adminInvite);
    const join = welcomeView(svc, ui).value;
    assert.match(join, /id="join-pass2"/);
    await svc.acceptInvite(adminInvite, 'надёжный-пароль');
    const rec = await svc.issue({ role: 'student', name: '<img src=x onerror=alert(1)>', months: 6 });
    ui.lastIssued = rec;
    const admin = adminView(svc, ui, 'https://site/').value;
    assert.match(admin, /value="manager"/, 'администратор может выбрать роль управляющего');
    assert.ok(!admin.includes('<img src=x'));
    svc.lock();
    assert.match(adminView(svc, ui, 'https://site/').value, /id="unlock-form"/);
    assert.match(accountCard(svc, ui).value, /Выйти/);

    const mgr = new AccountService({ store: new MemoryStore(), clock, school, pbkdf2Iterations: 1000 });
    await svc.unlock('надёжный-пароль');
    await mgr.acceptInvite((await svc.issue({ role: 'manager', name: 'Петров Пётр', months: 6 })).invite, 'пароль-123');
    assert.ok(!adminView(mgr, emptyAccountUi(), 'https://site/').value.includes('value="manager"'), 'управляющему роль не предлагается');
  });
});
