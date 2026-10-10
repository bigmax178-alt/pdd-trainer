/**
 * Сборка веб-клиента в один самодостаточный HTML-файл (JS и CSS встроены).
 *   node scripts/build-web.ts           → dist/index.html (полный документ) и dist/artifact.html (фрагмент для публикации)
 *   node scripts/build-web.ts --serve   → то же + локальный сервер http://localhost:5173
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

async function bundle(artifact: boolean): Promise<string> {
  const result = await build({
    entryPoints: [join(root, 'src/web/main.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
    write: false,
    logLevel: 'warning',
    define: { 'globalThis.__PDD_ARTIFACT__': String(artifact) },
  });
  return (result.outputFiles[0]?.text ?? '').replace(/<\/script/gi, '<\\/script');
}
const js = await bundle(false);
const artifactJs = await bundle(true);
const fontsCss = await readFile(join(root, 'assets/fonts/fonts.css'), 'utf8');
const css = fontsCss + (await readFile(join(root, 'src/web/styles.css'), 'utf8'));

const head = `<title>Автошкола «Светофор»</title>
<meta name="description" content="Тренажёр теоретического экзамена ГИБДД автошколы «Светофор»: билеты ABM и CD, экзамен по правилам, работа над ошибками">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="theme-color" content="#171B1F">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="apple-mobile-web-app-title" content="Светофор">
<style>${css}</style>`;
const body = (script: string) => `<div id="app"><p style="padding:24px">Загрузка тренажёра…</p></div>
<noscript><p style="padding:24px">Для работы тренажёра включите JavaScript.</p></noscript>
<script>${script}</script>`;

const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${head}
</head>
<body>
${body(js)}
</body>
</html>
`;

await mkdir(dist, { recursive: true });
await writeFile(join(dist, 'index.html'), page);
await writeFile(join(dist, 'artifact.html'), `${head}\n${body(artifactJs)}\n`);
console.log(`dist/index.html — ${(page.length / 1024).toFixed(1)} КБ (JS ${(js.length / 1024).toFixed(1)} КБ, CSS ${(css.length / 1024).toFixed(1)} КБ)`);

// Шрифты и иконки — свои (в репозитории), без обращений к Google Fonts.
await cp(join(root, 'assets/fonts'), join(dist, 'fonts'), { recursive: true, filter: (f) => !f.endsWith('.css') && !f.endsWith('.md') });
await cp(join(root, 'assets/icons'), join(dist, 'icons'), { recursive: true });
await writeFile(join(dist, 'manifest.webmanifest'), JSON.stringify({
  name: 'Автошкола «Светофор» — тренажёр ПДД',
  short_name: 'Светофор',
  description: 'Тренажёр теоретического экзамена ГИБДД',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: '#F3F4F1',
  theme_color: '#171B1F',
  lang: 'ru',
  icons: [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}));

// Частые ошибки учеников, опубликованные автошколой (school/hard.json), — необязательный файл.
const hard = join(root, 'school/hard.json');
if (await access(hard).then(() => true, () => false)) await cp(hard, join(dist, 'hard.json'));

// Официальные билеты и картинки (npm run fetch:official) кладутся рядом со страницей; без них работает демо-банк.
const pub = join(root, 'public');
const hasOfficial = await access(join(pub, 'content/official.json')).then(() => true, () => false);
// Настройки учётных записей автошколы (открытый ключ); без файла тренажёр открыт всем.
const school = join(root, 'school/school.json');
if (await access(school).then(() => true, () => false)) {
  await cp(school, join(dist, 'school.json'));
  console.log('Учётные записи включены: school.json скопирован в dist/');
}
if (hasOfficial) {
  await cp(pub, dist, { recursive: true });
  console.log('Официальный банк билетов скопирован в dist/');
} else {
  console.log('Официальный банк не подготовлен (npm run fetch:official) — сайт откроется с демо-банком');
}

// Service worker: имя кэша — хеш страницы и контента, список оболочки — всё, кроме картинок.
const shell = ['./', './index.html', './manifest.webmanifest', './school.json', './hard.json',
  ...(await readdir(join(dist, 'icons'))).map((f) => `./icons/${f}`),
  ...(await readdir(join(dist, 'fonts'))).map((f) => `./fonts/${f}`),
  ...(await readdir(join(dist, 'content')).catch(() => [] as string[])).map((f) => `./content/${f}`)];
const buildId = createHash('sha256').update(page).update(JSON.stringify(shell)).digest('hex').slice(0, 12);
const sw = await build({
  entryPoints: [join(root, 'src/web/sw.ts')],
  bundle: true, format: 'iife', target: 'es2020', minify: true, charset: 'utf8', write: false, logLevel: 'warning',
  define: { BUILD_ID: JSON.stringify(buildId), SHELL_FILES: JSON.stringify(shell) },
});
await writeFile(join(dist, 'sw.js'), sw.outputFiles[0]?.text ?? '');
console.log(`sw.js — сборка ${buildId}, в оболочке ${shell.length} файлов`);

if (process.argv.includes('--serve')) {
  const port = Number(process.env.PORT ?? 5173);
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.gif': 'image/gif',
    '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
  };
  createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const file = normalize(join(dist, path === '/' ? 'index.html' : path));
    if (!file.startsWith(dist)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Не найдено');
    }
  }).listen(port, () => console.log(`http://localhost:${port}`));
}
