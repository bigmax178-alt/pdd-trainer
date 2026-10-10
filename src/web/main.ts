import { AccountService } from '../app/accounts.ts';
import { systemClock } from '../app/ports.ts';
import { type SchoolConfig, parseSchoolConfig } from '../core/credentials.ts';
import { TrainerService } from '../app/trainer.ts';
import { DomainError } from '../core/types.ts';
import { findTicketSet } from '../content/categories.ts';
import { DEMO_PACK } from '../content/demo-bank.ts';
import { PackFormatError, parsePack } from '../content/pack-io.ts';
import { type CatalogGroup, parseSignCatalog } from '../content/signs.ts';
import type { ContentPack } from '../core/types.ts';
import { BrowserStore, PrefixedStore } from '../infra/stores.ts';
import { type AccountUi, accountCard, adminView, emptyAccountUi, welcomeView } from './views-accounts.ts';
import {
  type Route, type UiState, brandHeader, homeView, resultView, searchView, sessionView, setSignCatalog, settingsView, shell,
  signsView, statsView, ticketsView, topicsView,
} from './views.ts';
import { clock, html } from './dom.ts';
import { remainingMs } from '../core/exam.ts';

const ROUTES: readonly Route[] = ['home', 'tickets', 'topics', 'session', 'result', 'stats', 'signs', 'settings', 'search', 'admin'];

const store = new BrowserStore(() => window.localStorage);
// Сервис создаётся после загрузки контента (официальные билеты лежат рядом со страницей отдельным файлом).
let svc!: TrainerService;
let accounts!: AccountService;
let pack: ContentPack = DEMO_PACK;
let signCatalog: CatalogGroup[] | undefined;
let booted = false;
let unsubscribe: (() => void) | undefined;
const acct: AccountUi = emptyAccountUi();
const root = document.getElementById('app') as HTMLElement;

const ui: UiState = { route: routeFromHash(), selection: null, searchQuery: '', confirmReset: false, exportText: '', flash: null };
if (store.degraded) ui.flash = { kind: 'bad', text: 'Браузер запрещает сохранять данные: прогресс будет доступен только до закрытия вкладки.' };

function routeFromHash(): Route {
  const h = location.hash.replace(/^#/, '') as Route;
  return ROUTES.includes(h) ? h : 'home';
}

/** Синхронная навигация: маршрут меняется сразу, а не после асинхронного hashchange. */
function navigate(route: Route): void {
  ui.route = route;
  if (location.hash !== `#${route}`) {
    try {
      history.pushState(null, '', `#${route}`);
    } catch {
      /* в песочнице без History API маршрут живёт только в памяти */
    }
  }
  render();
}

function applyTheme(): void {
  const t = svc.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

/** Тренажёр текущего пользователя: у каждой учётной записи свой прогресс и настройки. */
function startTrainer(): void {
  const id = accounts.identity;
  const scoped = accounts.enabled && id ? new PrefixedStore(store, `pdd.u.${id.id}.`) : store;
  svc = new TrainerService({ store: scoped, clock: systemClock, defaultPack: pack });
  unsubscribe?.();
  unsubscribe = svc.subscribe(render);
}

const pageBase = () => `${location.origin}${location.pathname}`;

function render(): void {
  applyTheme();
  // Учётные записи включены, а вход не выполнен (или открыто новое приглашение) — экран входа.
  // Текущая учётная запись сменится только после подтверждения; «Отмена» возвращает в тренажёр.
  if (accounts.enabled && (!accounts.identity || acct.preview)) {
    root.innerHTML = html`${brandHeader()}<main id="main">${welcomeView(accounts, acct)}</main>`.value;
    return;
  }
  const now = systemClock.now();
  const s = svc.session;
  if (ui.route === 'session' && s?.kind === 'exam' && s.verdict !== 'in_progress') {
    navigate('result');
    return;
  }
  if (ui.route === 'admin' && !accounts.isStaff) ui.route = 'home';
  const user = accounts.identity;
  let body;
  switch (ui.route) {
    case 'tickets': body = ticketsView(svc); break;
    case 'topics': body = topicsView(svc); break;
    case 'session': body = sessionView(svc, now, ui.selection); break;
    case 'result': body = resultView(svc, now); break;
    case 'stats': body = statsView(svc, now); break;
    case 'signs': body = signsView(signCatalog); break;
    case 'settings': body = html`${accountCard(accounts, acct)}${settingsView(svc, ui)}`; break;
    case 'search': body = searchView(svc, ui); break;
    case 'admin': body = adminView(accounts, acct, pageBase()); break;
    default: body = homeView(svc, user);
  }
  root.innerHTML = shell(svc, ui, body, user).value;
}

let toastTimer: number | undefined;
function toast(text: string, kind: 'ok' | 'bad' = 'ok'): void {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = `toast ${kind === 'bad' ? 'bad' : ''}`;
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.append(el);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 3500);
}

function errorText(err: unknown): string {
  if (err instanceof DomainError || err instanceof Error) return err.message;
  return 'Что-то пошло не так. Обновите страницу.';
}

// ---------- Действия ----------

function start(fn: () => unknown): void {
  fn();
  ui.selection = null;
  window.scrollTo(0, 0);
  navigate('session');
}

/** Выбор варианта: ответ ещё не зафиксирован, выбор можно сменить. */
function onSelect(displayed: number): void {
  const s = svc.session;
  const item = s?.items[s.cursor];
  if (!s || !item || item.answer !== undefined || displayed < 0 || displayed >= item.optionOrder.length) return;
  ui.selection = { sessionId: s.id, itemIndex: s.cursor, displayed };
  render();
  document.getElementById('next-btn')?.focus({ preventScroll: true });
}

/** Кнопка на нижней панели: только здесь ответ фиксируется. */
function onConfirm(): void {
  const s = svc.session;
  const sel = ui.selection;
  if (!s || !sel || sel.sessionId !== s.id || sel.itemIndex !== s.cursor) return;
  ui.selection = null;
  const outcome = svc.answer(sel.displayed);
  const after = svc.session;
  if (!after) return;
  if (after.kind === 'exam') {
    if (outcome && 'addedQuestions' in outcome && outcome.addedQuestions > 0) {
      const block = (s.items[s.cursor] as { block?: number }).block ?? 0;
      toast(`Ошибка в блоке ${block}: добавлено ${outcome.addedQuestions} вопросов и 5 минут`, 'bad');
    }
    if (after.verdict !== 'in_progress') navigate('result');
    else onNext();
    return;
  }
  if (!svc.settings.instantFeedback) {
    onNext();
    return;
  }
  // Тренировка с разбором: показываем правильный ответ и пояснение, дальше — кнопка «Далее».
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelector('.explain')?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  document.getElementById('next-btn')?.focus({ preventScroll: true });
}

function onNext(): void {
  const s = svc.session;
  if (!s) return;
  if (s.kind === 'practice' && s.finishedAt !== undefined) {
    navigate('result');
    return;
  }
  svc.advance();
  window.scrollTo(0, 0);
}

/** Асинхронное действие с учётными записями: блокировка кнопок, ошибки — в карточку на экране. */
async function accountTask(task: () => Promise<void>): Promise<void> {
  if (acct.busy) return;
  acct.busy = true;
  acct.error = null;
  render();
  try {
    await task();
  } catch (err) {
    acct.error = errorText(err);
  } finally {
    acct.busy = false;
    render();
  }
}

function issuedById(id: string) {
  return (acct.lastIssued?.id === id ? acct.lastIssued : undefined) ?? accounts.issued().find((r) => r.id === id);
}

function copyText(text: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast('Ссылка скопирована — отправьте её лично'),
    () => {
      (document.getElementById('issued-link') as HTMLInputElement | null)?.select();
      toast('Выделите ссылку и скопируйте вручную');
    },
  );
}

/** Вход по приглашению: сначала показываем, кому оно выдано, вход — после подтверждения. */
async function openInvite(code: string): Promise<void> {
  acct.preview = await accounts.previewInvite(code);
  acct.pendingInvite = code;
}

function takeInviteFromHash(): string | null {
  if (!location.hash.startsWith('#invite=')) return null;
  const code = decodeURIComponent(location.hash.slice('#invite='.length));
  try {
    // Убираем код из адресной строки и истории браузера.
    history.replaceState(null, '', `${location.pathname}${location.search}#home`);
  } catch {
    /* без History API код останется в адресе до перехода */
  }
  return code;
}

const actions: Record<string, (arg: string) => void> = {
  'invite-cancel': () => { acct.preview = null; acct.pendingInvite = null; acct.error = null; render(); },
  'copy-link': (arg) => {
    const rec = issuedById(arg);
    if (rec) copyText(AccountService.inviteLink(pageBase(), rec.invite));
  },
  'share-link': (arg) => {
    const rec = issuedById(arg);
    if (!rec) return;
    const url = AccountService.inviteLink(pageBase(), rec.invite);
    if (navigator.share) {
      navigator.share({ title: 'Автошкола «Светофор»', text: `Приглашение в тренажёр ПДД: ${rec.name}`, url }).catch(() => undefined);
    } else {
      copyText(url);
    }
  },
  lock: () => { accounts.lock(); acct.lastIssued = null; render(); },
  'logout-ask': () => { acct.confirmLogout = true; render(); },
  'logout-cancel': () => { acct.confirmLogout = false; render(); },
  'logout-confirm': () => {
    accounts.logout();
    Object.assign(acct, emptyAccountUi());
    startTrainer();
    navigate('home');
  },
  'go-tickets': () => navigate('tickets'),
  'go-topics': () => navigate('topics'),
  'go-signs': () => navigate('signs'),
  'go-search': () => navigate('search'),
  'go-stats': () => navigate('stats'),
  'start-exam': () => start(() => svc.startExam()),
  'start-smart': () => start(() => svc.startSmart()),
  'start-marathon': () => start(() => svc.startMarathon()),
  'start-mistakes': () => start(() => svc.startMistakes()),
  'start-review': () => start(() => svc.startReview()),
  'start-hard': () => start(() => svc.startHard()),
  'start-favorites': () => start(() => svc.startFavorites()),
  'start-ticket': (arg) => start(() => svc.startTicket(Number(arg))),
  'start-topic': (arg) => start(() => svc.startTopic(arg)),
  'start-question': (arg) => start(() => svc.startQuestion(arg)),
  'start-search': () => start(() => svc.startSearch(ui.searchQuery)),
  select: (arg) => onSelect(Number(arg)),
  confirm: () => onConfirm(),
  next: () => onNext(),
  skip: () => { ui.selection = null; svc.skip(); },
  goto: (arg) => { ui.selection = null; svc.goTo(Number(arg)); },
  finish: () => { svc.finish(); navigate('result'); },
  'to-result': () => navigate('result'),
  favorite: (arg) => svc.toggleFavorite(arg),
  'set-bank': (arg) => {
    const set = findTicketSet(arg);
    if (!set) return;
    svc.updateSettings({ bank: set.bank });
    toast(`Билеты ${set.code}: категории ${set.categories.join(', ')}`);
  },
  export: () => { ui.exportText = svc.exportData(); render(); },
  'copy-export': () => {
    const area = document.getElementById('export-text') as HTMLTextAreaElement | null;
    navigator.clipboard.writeText(ui.exportText).then(
      () => toast('Скопировано в буфер обмена'),
      () => { area?.select(); toast('Выделите текст и скопируйте вручную'); },
    );
  },
  'reset-ask': () => { ui.confirmReset = true; render(); },
  'reset-cancel': () => { ui.confirmReset = false; render(); },
  'reset-confirm': () => { ui.confirmReset = false; ui.exportText = ''; svc.resetProgress(); toast('Прогресс сброшен'); },
  'reset-pack': () => { svc.resetPack(); toast('Подключён демо-банк'); },
};

root.addEventListener('click', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-action]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  const handler = actions[el.dataset.action ?? ''];
  if (!handler) return;
  try {
    handler(el.dataset.arg ?? '');
  } catch (err) {
    toast(errorText(err), 'bad');
  }
});

root.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  const key = t.dataset.setting;
  if (key === 'dailyGoal') svc.updateSettings({ dailyGoal: Number(t.value) });
  else if (key === 'theme') svc.updateSettings({ theme: t.value as 'auto' | 'light' | 'dark' });
  else if (key === 'instantFeedback' || key === 'shuffleOptions' || key === 'examFailFast') {
    svc.updateSettings({ [key]: (t as HTMLInputElement).checked });
  }
  const file = t instanceof HTMLInputElement ? t.files?.[0] : undefined;
  if (!file) return;
  file.text().then((text) => {
    if (t.id === 'import-file') {
      svc.importData(text);
      ui.flash = { kind: 'ok', text: 'Прогресс импортирован и объединён с текущим' };
    } else if (t.id === 'pack-file') {
      const pack = svc.loadCustomPack(text);
      ui.flash = { kind: 'ok', text: `Загружен банк «${pack.title}»: ${pack.questions.length} вопросов` };
    }
    render();
  }).catch((err: unknown) => {
    ui.flash = { kind: 'bad', text: errorText(err) };
    render();
  });
});

root.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const data = new FormData(form);
  const field = (name: string) => String(data.get(name) ?? '');
  switch (form.id) {
    case 'invite-form':
      void accountTask(() => openInvite(field('invite')));
      break;
    case 'join-form':
      void accountTask(async () => {
        const code = acct.pendingInvite;
        if (!code || !acct.preview) return;
        if (acct.preview.staff && field('password') !== field('password2')) throw new Error('Пароли не совпадают');
        await accounts.acceptInvite(code, acct.preview.staff ? field('password') : undefined);
        acct.preview = null;
        acct.pendingInvite = null;
        startTrainer();
        navigate(accounts.isStaff ? 'admin' : 'home');
        toast(`Добро пожаловать, ${accounts.identity?.name ?? ''}`);
      });
      break;
    case 'unlock-form':
      void accountTask(() => accounts.unlock(field('password')));
      break;
    case 'issue-form':
      void accountTask(async () => {
        const role = field('role') === 'manager' ? 'manager' : 'student';
        acct.lastIssued = await accounts.issue({ role, name: field('name'), months: Number(field('months')) });
      });
      break;
    default: {
      const input = document.getElementById('search-input') as HTMLInputElement | null;
      ui.searchQuery = input?.value.trim() ?? '';
      render();
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (!booted || ui.route !== 'session' || e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement;
  if (target.closest('input, textarea, select')) return;
  const s = svc.session;
  if (!s) return;
  const item = s.items[s.cursor];
  try {
    if (/^[1-5]$/.test(e.key)) {
      onSelect(Number(e.key) - 1);
    } else if ((e.key === 'Enter' || e.key === 'ArrowRight') && !target.closest('button, a')) {
      if (item?.answer !== undefined) onNext();
      else onConfirm();
    } else if (e.code === 'KeyS' && s.kind === 'exam') {
      ui.selection = null;
      svc.skip();
    } else if (e.code === 'KeyF' && item) {
      svc.toggleFavorite(item.questionId);
    } else {
      return;
    }
    e.preventDefault();
  } catch (err) {
    toast(errorText(err), 'bad');
  }
});

window.addEventListener('hashchange', () => {
  const code = booted ? takeInviteFromHash() : null;
  if (code) {
    void accountTask(async () => {
      await openInvite(code);
    });
  }
  ui.route = routeFromHash();
  ui.flash = null;
  ui.confirmReset = false;
  render();
  window.scrollTo(0, 0);
});

// Таймер экзамена: обновляем только табло, полная перерисовка — при истечении времени.
window.setInterval(() => {
  if (!booted) return;
  const s = svc.session;
  if (!s || s.kind !== 'exam' || s.verdict !== 'in_progress') return;
  if (svc.tick()) {
    toast('Время экзамена истекло', 'bad');
    navigate('result');
    return;
  }
  const el = document.getElementById('timer');
  if (el) {
    const left = remainingMs(s, systemClock.now());
    el.textContent = clock(left);
    el.classList.toggle('low', left < 120_000);
  }
}, 1000);

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Официальные билеты и справочник знаков; без них (файл открыт локально, нет сети) — демо-банк. */
async function loadContent(): Promise<{ pack: ContentPack; signs?: CatalogGroup[]; packError?: string }> {
  const [pack, signs] = await Promise.allSettled([
    fetchJson('./content/official.json').then(parsePack),
    fetchJson('./content/signs.json').then(parseSignCatalog),
  ]);
  return {
    pack: pack.status === 'fulfilled' ? pack.value : DEMO_PACK,
    ...(signs.status === 'fulfilled' ? { signs: signs.value } : {}),
    ...(pack.status === 'rejected' && pack.reason instanceof PackFormatError ? { packError: pack.reason.message } : {}),
  };
}

/** Настройки автошколы: открытый ключ и список блокировок. Нет файла — учётные записи выключены (демо). */
async function loadSchool(): Promise<SchoolConfig | null> {
  try {
    return parseSchoolConfig(await fetchJson('./school.json'));
  } catch {
    return null;
  }
}

void Promise.all([loadContent(), loadSchool()]).then(async ([content, school]) => {
  pack = content.pack;
  signCatalog = content.signs;
  setSignCatalog(content.signs);
  if (content.packError) ui.flash = { kind: 'bad', text: `Официальные билеты не загрузились, открыт демо-банк: ${content.packError}` };
  accounts = new AccountService({ store, clock: systemClock, school });
  await accounts.restore();
  const code = takeInviteFromHash();
  if (code && accounts.enabled) {
    try {
      await openInvite(code);
    } catch (err) {
      acct.error = errorText(err);
    }
  }
  startTrainer();
  booted = true;
  render();
});
