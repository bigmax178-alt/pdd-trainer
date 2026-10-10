import { systemClock } from '../app/ports.ts';
import { TrainerService } from '../app/trainer.ts';
import { DomainError } from '../core/types.ts';
import { findTicketSet } from '../content/categories.ts';
import { DEMO_PACK } from '../content/demo-bank.ts';
import { PackFormatError, parsePack } from '../content/pack-io.ts';
import { type CatalogGroup, parseSignCatalog } from '../content/signs.ts';
import type { ContentPack } from '../core/types.ts';
import { BrowserStore } from '../infra/stores.ts';
import {
  type Route, type UiState, homeView, resultView, searchView, sessionView, settingsView, shell,
  signsView, statsView, ticketsView, topicsView,
} from './views.ts';
import { clock } from './dom.ts';
import { remainingMs } from '../core/exam.ts';

const ROUTES: readonly Route[] = ['home', 'tickets', 'topics', 'session', 'result', 'stats', 'signs', 'settings', 'search'];

const store = new BrowserStore(() => window.localStorage);
// Сервис создаётся после загрузки контента (официальные билеты лежат рядом со страницей отдельным файлом).
let svc!: TrainerService;
let signCatalog: CatalogGroup[] | undefined;
let booted = false;
const root = document.getElementById('app') as HTMLElement;

const ui: UiState = { route: routeFromHash(), searchQuery: '', confirmReset: false, exportText: '', flash: null };
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

function render(): void {
  applyTheme();
  const now = systemClock.now();
  const s = svc.session;
  if (ui.route === 'session' && s?.kind === 'exam' && s.verdict !== 'in_progress') {
    navigate('result');
    return;
  }
  let body;
  switch (ui.route) {
    case 'tickets': body = ticketsView(svc); break;
    case 'topics': body = topicsView(svc); break;
    case 'session': body = sessionView(svc, now); break;
    case 'result': body = resultView(svc, now); break;
    case 'stats': body = statsView(svc, now); break;
    case 'signs': body = signsView(signCatalog); break;
    case 'settings': body = settingsView(svc, ui); break;
    case 'search': body = searchView(svc, ui); break;
    default: body = homeView(svc);
  }
  root.innerHTML = shell(svc, ui, body).value;
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
  window.scrollTo(0, 0);
  navigate('session');
}

function onAnswer(displayed: number): void {
  const s = svc.session;
  const item = s?.items[s.cursor];
  if (!s || !item || item.answer !== undefined || displayed >= item.optionOrder.length) return;
  const outcome = svc.answer(displayed);
  const after = svc.session;
  if (!after) return;
  if (after.kind === 'exam') {
    if (outcome && 'addedQuestions' in outcome && outcome.addedQuestions > 0) {
      const block = (s.items[s.cursor] as { block?: number }).block ?? 0;
      toast(`Ошибка в блоке ${block}: добавлено ${outcome.addedQuestions} вопросов и 5 минут`, 'bad');
    }
    if (after.verdict !== 'in_progress') {
      navigate('result');
      return;
    }
  }
  // Автоперехода нет: показываем разбор и панель «Далее», фокус — на кнопке (Enter/пробел нажимают её).
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

const actions: Record<string, (arg: string) => void> = {
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
  answer: (arg) => onAnswer(Number(arg)),
  next: () => onNext(),
  skip: () => svc.skip(),
  goto: (arg) => svc.goTo(Number(arg)),
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
  const input = document.getElementById('search-input') as HTMLInputElement | null;
  ui.searchQuery = input?.value.trim() ?? '';
  render();
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
      onAnswer(Number(e.key) - 1);
    } else if ((e.key === 'Enter' || e.key === 'ArrowRight') && !target.closest('button, a')) {
      if (item?.answer !== undefined) onNext();
    } else if (e.code === 'KeyS' && s.kind === 'exam') {
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

void loadContent().then(({ pack, signs, packError }) => {
  svc = new TrainerService({ store, clock: systemClock, defaultPack: pack });
  signCatalog = signs;
  if (packError) ui.flash = { kind: 'bad', text: `Официальные билеты не загрузились, открыт демо-банк: ${packError}` };
  booted = true;
  svc.subscribe(render);
  render();
});
