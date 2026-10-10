import type { Topic } from '../core/types.ts';

/** Темы ПДД. Названия совпадают с официальной рубрикацией экзаменационных вопросов. */
export const TOPICS: readonly Topic[] = [
  { id: 'general', title: 'Общие положения' },
  { id: 'duties', title: 'Общие обязанности водителей' },
  { id: 'signs', title: 'Дорожные знаки' },
  { id: 'markings', title: 'Дорожная разметка' },
  { id: 'signals', title: 'Сигналы светофора и регулировщика' },
  { id: 'hazard', title: 'Аварийная сигнализация и знак аварийной остановки' },
  { id: 'maneuver', title: 'Начало движения, маневрирование' },
  { id: 'lanes', title: 'Расположение транспортных средств на проезжей части' },
  { id: 'speed', title: 'Скорость движения' },
  { id: 'overtaking', title: 'Обгон, опережение, встречный разъезд' },
  { id: 'stopping', title: 'Остановка и стоянка' },
  { id: 'intersections', title: 'Проезд перекрёстков' },
  { id: 'crossings', title: 'Пешеходные переходы и остановки маршрутных ТС' },
  { id: 'railway', title: 'Движение через железнодорожные пути' },
  { id: 'motorway', title: 'Движение по автомагистралям' },
  { id: 'residential', title: 'Движение в жилых зонах' },
  { id: 'route', title: 'Приоритет маршрутных транспортных средств' },
  { id: 'lights', title: 'Световые приборы и звуковые сигналы' },
  { id: 'towing', title: 'Буксировка механических транспортных средств' },
  { id: 'people', title: 'Перевозка людей' },
  { id: 'cargo', title: 'Перевозка грузов' },
  { id: 'defects', title: 'Неисправности и условия допуска ТС к эксплуатации' },
  { id: 'safety', title: 'Безопасность движения и техника управления' },
  { id: 'firstaid', title: 'Оказание первой помощи' },
];

/** Транслитерация названия темы в стабильный идентификатор (для импорта внешних банков). */
export function topicIdFromTitle(title: string): string {
  const known = TOPICS.find((t) => t.title.toLowerCase() === title.trim().toLowerCase());
  if (known) return known.id;
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  const slug = [...title.trim().toLowerCase()].map((ch) => map[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `t-${slug || 'other'}`.slice(0, 60);
}
