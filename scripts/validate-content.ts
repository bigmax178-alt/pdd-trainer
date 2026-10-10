/**
 * Проверка банка вопросов (CI-гейт).
 *   node scripts/validate-content.ts               — встроенный демо-банк
 *   node scripts/validate-content.ts bank.json     — произвольный пакет
 * Код выхода 1 при ошибках.
 */
import { readFile } from 'node:fs/promises';
import type { ContentPack } from '../src/core/types.ts';
import { hasErrors, validatePack } from '../src/core/validation.ts';
import { DEMO_PACK } from '../src/content/demo-bank.ts';
import { hasSign } from '../src/content/signs.ts';

const file = process.argv[2];
const pack = file ? (JSON.parse(await readFile(file, 'utf8')) as ContentPack) : DEMO_PACK;
const issues = validatePack(pack);

for (const q of pack.questions) {
  if (q.image?.kind === 'signs') {
    for (const s of q.image.signs) {
      if (!hasSign(s)) issues.push({ level: 'error', code: 'unknown_sign', message: `Вопрос ${q.id}: нет векторного знака ${s}` });
    }
  }
}

for (const i of issues) console.log(`${i.level === 'error' ? '✗' : '!'} [${i.code}] ${i.message}`);
const errors = issues.filter((i) => i.level === 'error').length;
console.log(`${pack.title} ${pack.version}: ${pack.questions.length} вопросов, билетов AB ${pack.banks.AB.length}, CD ${pack.banks.CD.length}; ошибок ${errors}, предупреждений ${issues.length - errors}`);
process.exit(hasErrors(issues) ? 1 : 0);
