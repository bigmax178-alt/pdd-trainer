/// <reference lib="webworker" />
/**
 * Service worker: тренажёр работает без интернета.
 *  - оболочка (страница, билеты, знаки, правила, шрифты) кэшируется при установке под именем сборки;
 *  - картинки к вопросам — по мере обращения (имена файлов — хеши содержимого, поэтому кэш бессрочный);
 *  - school.json (блокировки) и страница — сначала сеть, при её отсутствии — кэш.
 * BUILD_ID подставляет сборщик: новая сборка → новый кэш оболочки, старые удаляются.
 */
declare const BUILD_ID: string;
declare const SHELL_FILES: string[];
const sw = self as unknown as ServiceWorkerGlobalScope;

const SHELL = `pdd-shell-${BUILD_ID}`;
const IMAGES = 'pdd-images-v1';
const NETWORK_FIRST = new Set(['./', './index.html', './school.json', './hard.json']);

sw.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Оболочка кэшируется по одному файлу: отсутствие необязательного файла (hard.json) не ломает установку.
    await Promise.all(SHELL_FILES.map(async (f) => {
      try {
        const res = await fetch(f, { cache: 'no-cache' });
        if (res.ok) await cache.put(f, res);
      } catch {
        /* нет сети при установке — файл подтянется позже */
      }
    }));
  })());
});

sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('pdd-shell-') && key !== SHELL) await caches.delete(key);
    }
    await sw.clients.claim();
  })());
});

sw.addEventListener('message', (event) => {
  if ((event.data as { type?: string })?.type === 'SKIP_WAITING') void sw.skipWaiting();
});

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  const base = new URL('./', sw.location.href).pathname;
  if (!url.pathname.startsWith(base)) return;
  const rel = `./${url.pathname.slice(base.length)}`;

  if (rel.startsWith('./images/')) {
    event.respondWith(cacheFirst(IMAGES, req));
  } else if (NETWORK_FIRST.has(rel) || req.mode === 'navigate') {
    event.respondWith(networkFirst(SHELL, req));
  } else {
    event.respondWith(cacheFirst(SHELL, req));
  }
});

async function cacheFirst(cacheName: string, req: Request): Promise<Response> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

async function networkFirst(cacheName: string, req: Request): Promise<Response> {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch {
    const hit = (await cache.match(req, { ignoreSearch: true })) ?? (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
    return hit ?? new Response('Нет соединения', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}
