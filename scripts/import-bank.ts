/**
 * Импорт полного банка билетов из открытого набора в формате etspring/pdd_russia
 * (папки questions/A_B/tickets и questions/C_D/tickets с файлами «Билет N.json»).
 *
 *   git clone https://github.com/etspring/pdd_russia.git ../pdd_russia
 *   npm run import:bank -- ../pdd_russia --out data/bank.json \
 *     --image-base https://raw.githubusercontent.com/etspring/pdd_russia/master/
 *
 * Результат — JSON-пакет, который загружается в веб-клиенте (Настройки → Банк вопросов)
 * или на сервер (переменная CONTENT_FILE).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { importExternalBank } from '../src/content/pack-io.ts';
import { readTickets } from './official-source.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const source = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!source) {
  console.error('Использование: npm run import:bank -- <папка pdd_russia> [--out data/bank.json] [--image-base URL]');
  process.exit(2);
}
const out = flag('--out') ?? 'data/bank.json';

const imageBase = flag('--image-base');
const { pack, issues } = importExternalBank({
  AB: await readTickets(join(source, 'questions/A_B/tickets')),
  CD: await readTickets(join(source, 'questions/C_D/tickets')),
  ...(imageBase ? { imageBaseUrl: imageBase.endsWith('/') ? imageBase : `${imageBase}/` } : {}),
});

const errors = issues.filter((i) => i.level === 'error');
for (const i of issues.slice(0, 50)) console.log(`${i.level === 'error' ? '✗' : '!'} ${i.message}`);
if (errors.length) {
  console.error(`Импорт остановлен: ${errors.length} ошибок`);
  process.exit(1);
}
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(pack));
console.log(`Готово: ${out} — ${pack.questions.length} вопросов, билетов AB ${pack.banks.AB.length}, CD ${pack.banks.CD.length}, тем ${pack.topics.length}`);
