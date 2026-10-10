/**
 * Первичная настройка учётных записей автошколы.
 *   - создаёт корневую пару ключей;
 *   - открытый ключ записывает в school/school.json (публикуется вместе с сайтом);
 *   - ссылку-доступ администратора (с закрытым ключом) записывает в файл ВНЕ репозитория и не выводит на экран.
 *
 *   node scripts/school-init.ts --site https://<логин>.github.io/<репозиторий>/ --out "../Ключ администратора.txt"
 *
 * Повторный запуск с --force выпускает новый ключ: все прежние приглашения перестанут работать.
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeInvite, generateKeyPair } from '../src/core/credentials.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const name = flag('--name') ?? 'Автошкола «Светофор»';
const site = flag('--site');
const out = flag('--out');
const config = resolve(root, flag('--config') ?? 'school/school.json');
if (!site || !out) {
  console.error('Использование: node scripts/school-init.ts --site <адрес сайта> --out <файл для ключа администратора> [--name ...] [--force]');
  process.exit(2);
}
const outPath = resolve(out);
if (outPath.startsWith(root)) {
  console.error('Файл с ключом администратора нельзя класть внутрь репозитория — укажите путь снаружи');
  process.exit(2);
}
const exists = await access(config).then(() => true, () => false);
if (exists && !args.includes('--force')) {
  console.error(`${config} уже существует. Новый ключ сделает недействительными все выданные приглашения; для этого добавьте --force`);
  process.exit(1);
}

const keys = await generateKeyPair();
await mkdir(dirname(config), { recursive: true });
await writeFile(config, `${JSON.stringify({ name, rootKey: keys.publicKey, revoked: [] }, null, 2)}\n`);

const link = `${site.replace(/#.*$/, '')}#invite=${encodeInvite([], keys.privateKey)}`;
await writeFile(outPath, `${name} — доступ администратора

ВНИМАНИЕ: это главный ключ системы учётных записей. С ним можно создавать управляющих и учеников.
Не публикуйте его и не пересылайте посторонним. Храните копию в надёжном месте (например, в «Избранном» Telegram
или в менеджере паролей). Если ключ утёк — попросите выпустить новый: старые приглашения перестанут работать.

Как войти:
1. Откройте ссылку на телефоне или компьютере:

${link}

2. Придумайте пароль — он защищает создание учётных записей на этом устройстве.
3. Раздел «Управление»: создавайте управляющих и учеников и отправляйте им их ссылки-приглашения.
`, { mode: 0o600 });

console.log(`Готово: открытый ключ записан в ${config}`);
console.log(`Ссылка-доступ администратора сохранена в файл: ${outPath} (на экран не выводится)`);
