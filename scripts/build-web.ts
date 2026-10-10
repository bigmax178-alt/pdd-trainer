/**
 * Сборка веб-клиента в один самодостаточный HTML-файл (JS и CSS встроены).
 *   node scripts/build-web.ts           → dist/index.html (полный документ) и dist/artifact.html (фрагмент для публикации)
 *   node scripts/build-web.ts --serve   → то же + локальный сервер http://localhost:5173
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
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
const css = await readFile(join(root, 'src/web/styles.css'), 'utf8');

const head = `<title>ПДД Тренер</title>
<meta name="description" content="Тренажёр теоретического экзамена ГИБДД: билеты, экзамен по правилам, темы, марафон, работа над ошибками">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&family=PT+Mono&family=Unbounded:wght@600;700&display=swap">
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

if (process.argv.includes('--serve')) {
  const port = Number(process.env.PORT ?? 5173);
  createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page);
  }).listen(port, () => console.log(`http://localhost:${port}`));
}
