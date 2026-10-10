import { AccountService, type InvitePreview, type IssuedRecord, MIN_PASSWORD } from '../app/accounts.ts';
import { type Identity, ROLE_TITLE } from '../core/credentials.ts';
import { type SafeHtml, html } from './dom.ts';

/** Состояние экранов учётных записей (только в памяти вкладки). */
export interface AccountUi {
  preview: InvitePreview | null;
  pendingInvite: string | null;
  error: string | null;
  busy: boolean;
  lastIssued: IssuedRecord | null;
  confirmLogout: boolean;
}

export const emptyAccountUi = (): AccountUi => ({
  preview: null, pendingInvite: null, error: null, busy: false, lastIssued: null, confirmLogout: false,
});

/** Логотип автошколы «Светофор»: вертикальный светофор. */
export function logo(height = 34): SafeHtml {
  return html`<svg class="logo" viewBox="0 0 24 40" width="${Math.round(height * 0.6)}" height="${height}" aria-hidden="true">
    <rect x="1" y="1" width="22" height="38" rx="7" fill="#20252A" stroke="#3B4248"/>
    <circle cx="12" cy="10" r="5" fill="#E5322B"/><circle cx="12" cy="20" r="5" fill="#F5B300"/><circle cx="12" cy="30" r="5" fill="#26B24F"/>
  </svg>`;
}

export function fmtDate(sec: number): string {
  if (!sec) return 'бессрочно';
  const d = new Date(sec * 1000);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

const term = (exp: number) => (exp ? `доступ до ${fmtDate(exp)}` : 'бессрочный доступ');

function errorBox(a: AccountUi): SafeHtml | '' {
  return a.error ? html`<div class="notice" role="alert">${a.error}</div>` : '';
}

/** Экран для тех, кто ещё не вошёл: вход по ссылке или коду приглашения. */
export function welcomeView(acc: AccountService, a: AccountUi): SafeHtml {
  return html`
    <section class="welcome">
      <div class="welcome-brand">${logo(72)}
        <div><h1 class="welcome-title">${acc.school?.name ?? 'Светофор'}</h1>
          <p class="muted">Тренажёр теоретического экзамена ГИБДД: официальные билеты ABM и CD, экзамен по правилам, работа над ошибками.</p></div>
      </div>
      ${acc.problem ? html`<div class="notice" role="alert">${acc.problem}</div>` : ''}
      ${errorBox(a)}
      ${a.preview ? joinCard(a.preview, a) : html`
        <form class="card section" id="invite-form">
          <h2>Вход по приглашению</h2>
          <p class="muted">Приглашение выдаёт администратор или управляющий автошколы. Откройте ссылку из сообщения — вход произойдёт сам.
            Если ссылка не открывается, вставьте её сюда целиком.</p>
          <label class="field" for="invite-text"><span>Ссылка или код приглашения</span>
            <textarea id="invite-text" name="invite" rows="3" required autocomplete="off" spellcheck="false"></textarea></label>
          <div><button class="btn btn-primary" type="submit" ${a.busy ? 'disabled' : ''}>Продолжить</button></div>
        </form>`}
    </section>`;
}

function joinCard(p: InvitePreview, a: AccountUi): SafeHtml {
  const id = p.identity;
  return html`
    <form class="card section join" id="join-form">
      <span class="label">Приглашение автошколы</span>
      <h2>${id.name}</h2>
      <p><span class="role-pill role-${id.role}">${ROLE_TITLE[id.role]}</span> <span class="muted">${term(id.exp)}</span></p>
      ${p.staff ? html`
        <p class="muted">Придумайте пароль: он понадобится, чтобы создавать учётные записи с этого устройства.
          Ссылку-приглашение сохраните — по ней можно войти на другом устройстве.</p>
        <label class="field" for="join-pass"><span>Пароль (не короче ${MIN_PASSWORD} символов)</span>
          <input type="password" id="join-pass" name="password" minlength="${MIN_PASSWORD}" required autocomplete="new-password"></label>
        <label class="field" for="join-pass2"><span>Повторите пароль</span>
          <input type="password" id="join-pass2" name="password2" minlength="${MIN_PASSWORD}" required autocomplete="new-password"></label>` : ''}
      <div class="btn-row">
        <button class="btn btn-primary" type="submit" ${a.busy ? 'disabled' : ''}>${a.busy ? 'Проверяем…' : 'Войти'}</button>
        <button class="btn" type="button" data-action="invite-cancel">Отмена</button>
      </div>
    </form>`;
}

/** Плашка пользователя в шапке. */
export function userChip(id: Identity): SafeHtml {
  const sub = id.role === 'admin' ? 'все права' : ROLE_TITLE[id.role];
  return html`<a class="user-chip" href="#settings" title="Учётная запись"><span class="user-name">${id.name}</span><span class="user-role">${sub}</span></a>`;
}

/** Блок «Учётная запись» в настройках. */
export function accountCard(acc: AccountService, a: AccountUi): SafeHtml {
  const id = acc.identity;
  if (!id) return html``;
  return html`
    <section class="card section"><h2>Учётная запись</h2>
      <p><b>${id.name}</b> · <span class="role-pill role-${id.role}">${ROLE_TITLE[id.role]}</span> <span class="muted">${term(id.exp)}</span></p>
      <p class="muted">Прогресс хранится на этом устройстве. На другом устройстве войдите по той же ссылке-приглашению.</p>
      <div class="btn-row">${a.confirmLogout
        ? html`<button class="btn btn-danger" data-action="logout-confirm">Да, выйти</button><button class="btn" data-action="logout-cancel">Отмена</button>`
        : html`<button class="btn" data-action="logout-ask">Выйти</button>`}</div>
    </section>`;
}

/** Раздел «Управление»: создание учётных записей и журнал выданных. */
export function adminView(acc: AccountService, a: AccountUi, base: string): SafeHtml {
  const id = acc.identity;
  if (!id || !acc.isStaff) return html`<section class="card section"><h1>Нет доступа</h1></section>`;
  if (acc.locked) {
    return html`
      <section class="section narrow"><h1>Управление</h1>${errorBox(a)}
        <form class="card section" id="unlock-form">
          <p>Введите пароль, который вы придумали при входе по ссылке-приглашению.</p>
          <label class="field" for="unlock-pass"><span>Пароль</span>
            <input type="password" id="unlock-pass" name="password" required autocomplete="current-password"></label>
          <div><button class="btn btn-primary" type="submit" ${a.busy ? 'disabled' : ''}>${a.busy ? 'Проверяем…' : 'Разблокировать'}</button></div>
        </form>
      </section>`;
  }
  const isAdmin = id.role === 'admin';
  const list = acc.issued();
  const last = a.lastIssued;
  return html`
    <section class="section"><div class="section-head"><h1>Управление</h1>
      <button class="btn btn-ghost" data-action="lock">Заблокировать до ввода пароля</button></div>
      <p class="muted">${isAdmin ? 'Администратор создаёт управляющих и учеников.' : 'Управляющий создаёт учётные записи учеников.'}
        Учётная запись — это ссылка-приглашение: отправьте её человеку лично.</p>
    </section>
    ${errorBox(a)}
    <form class="card section" id="issue-form">
      <h2>Новая учётная запись</h2>
      <label class="field" for="issue-name"><span>Фамилия и имя</span>
        <input type="text" id="issue-name" name="name" required minlength="2" maxlength="80" autocomplete="off" placeholder="Например: Иванов Иван"></label>
      ${isAdmin ? html`<fieldset class="field roles"><legend>Роль</legend>
        <label><input type="radio" name="role" value="student" checked> Ученик</label>
        <label><input type="radio" name="role" value="manager"> Управляющий</label></fieldset>` : html`<input type="hidden" name="role" value="student">`}
      <label class="field" for="issue-term"><span>Срок доступа</span>
        <select id="issue-term" name="months">
          <option value="3">3 месяца</option><option value="6" selected>6 месяцев</option><option value="12">12 месяцев</option><option value="0">Бессрочно</option>
        </select></label>
      <div><button class="btn btn-primary" type="submit" ${a.busy ? 'disabled' : ''}>${a.busy ? 'Создаём…' : 'Создать учётную запись'}</button></div>
    </form>
    ${last ? html`
      <section class="card section issued-card" aria-live="polite">
        <h2>Готово: ${last.name}</h2>
        <p><span class="role-pill role-${last.role}">${ROLE_TITLE[last.role]}</span> <span class="muted">${term(last.exp)}</span></p>
        ${last.role === 'manager' ? html`<p class="notice">Ссылка управляющего — это ключ для создания учеников. Передавайте её только лично.</p>` : ''}
        <label class="field" for="issued-link"><span>Ссылка-приглашение</span>
          <input type="text" id="issued-link" readonly value="${AccountService.inviteLink(base, last.invite)}"></label>
        <div class="btn-row">
          <button class="btn btn-primary" type="button" data-action="copy-link" data-arg="${last.id}">Скопировать ссылку</button>
          <button class="btn" type="button" data-action="share-link" data-arg="${last.id}">Отправить…</button>
        </div>
      </section>` : ''}
    <section class="section"><h2>Выданные доступы <span class="muted">(${list.length})</span></h2>
      ${list.length ? html`<div class="card table-wrap"><table>
        <thead><tr><th>Имя</th><th>Роль</th><th>Создан</th><th>Действует</th><th></th></tr></thead>
        <tbody>${list.map((r) => html`<tr>
          <td>${r.name}<br><span class="mono muted id-small">ID ${r.id}</span></td><td><span class="role-pill role-${r.role}">${ROLE_TITLE[r.role]}</span></td>
          <td class="num">${fmtDate(Math.floor(r.createdAt / 1000))}</td><td class="num">${r.exp ? `до ${fmtDate(r.exp)}` : 'бессрочно'}</td>
          <td><button class="btn btn-ghost" data-action="copy-link" data-arg="${r.id}">Ссылка</button></td></tr>`)}</tbody>
      </table></div>
      <p class="muted note">Журнал хранится на этом устройстве.${isAdmin ? html` Чтобы заблокировать доступ, добавьте его ID из таблицы в список <span class="mono">revoked</span> файла <span class="mono">school/school.json</span> в репозитории.` : ''}</p>`
        : html`<p class="muted">Пока никого. Созданные учётные записи появятся здесь.</p>`}
    </section>`;
}
