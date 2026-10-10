/**
 * Векторная библиотека дорожных знаков (ГОСТ Р 52290, схематично).
 * Знаки рисуются кодом: нет внешних картинок, идеально чёткие на любом экране, весят байты.
 * Спецификация знака в контенте: код и необязательное значение через двоеточие, например «3.24:40».
 */
export type SignGroup =
  | 'Предупреждающие' | 'Приоритета' | 'Запрещающие' | 'Предписывающие' | 'Особых предписаний' | 'Информационные';

export interface SignDef {
  readonly code: string;
  readonly title: string;
  readonly group: SignGroup;
  readonly defaultValue?: string;
  readonly draw: (value: string) => string;
}

const RED = '#D52B1E';
const BLUE = '#0B5FB0';
const YELLOW = '#FFD200';
const BLACK = '#1A1A1A';
const GREEN = '#13804E';
const WHITE = '#FFFFFF';

const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c);

const triangle = (inner: string) =>
  `<path d="M50 9 L93 85 H7 Z" fill="${WHITE}" stroke="${RED}" stroke-width="8" stroke-linejoin="round"/>${inner}`;
const roundProhibit = (inner: string, fill = WHITE) =>
  `<circle cx="50" cy="50" r="43" fill="${fill}" stroke="${RED}" stroke-width="9"/>${inner}`;
const blueRound = (inner: string) =>
  `<circle cx="50" cy="50" r="46" fill="${BLUE}" stroke="${WHITE}" stroke-width="2"/>${inner}`;
const square = (inner: string, fill = BLUE) =>
  `<rect x="4" y="4" width="92" height="92" rx="8" fill="${fill}" stroke="${WHITE}" stroke-width="2"/>${inner}`;
const endZone = (inner: string) =>
  `<circle cx="50" cy="50" r="44" fill="${WHITE}" stroke="#9A9A9A" stroke-width="3"/>${inner}` +
  [-16, -8, 0, 8, 16].map((d) => `<line x1="${78 + d}" y1="${22 + d}" x2="${22 + d}" y2="${78 + d}" stroke="${BLACK}" stroke-width="2"/>`).join('');
const slash = `<line x1="21" y1="21" x2="79" y2="79" stroke="${RED}" stroke-width="8"/>`;
const text = (value: string, size: number, fill = BLACK, y = 50) =>
  `<text x="50" y="${y}" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${size}" fill="${fill}" text-anchor="middle" dominant-baseline="central">${escapeXml(value)}</text>`;

const arrowUp = (color: string, x = 50) =>
  `<rect x="${x - 5}" y="40" width="10" height="40" fill="${color}"/><polygon points="${x},16 ${x + 16},42 ${x - 16},42" fill="${color}"/>`;
const arrowRight = (color: string) =>
  `<path d="M42 82 V54 Q42 42 54 42 H62" fill="none" stroke="${color}" stroke-width="10"/><polygon points="82,42 60,26 60,58" fill="${color}"/>`;
const arrowLeft = (color: string) =>
  `<g transform="translate(100 0) scale(-1 1)">${arrowRight(color)}</g>`;
const car = (x: number, color: string) =>
  `<rect x="${x - 11}" y="48" width="22" height="14" rx="3" fill="${color}"/><rect x="${x - 7}" y="40" width="14" height="10" rx="3" fill="${color}"/>` +
  `<rect x="${x - 10}" y="61" width="5" height="6" fill="${color}"/><rect x="${x + 5}" y="61" width="5" height="6" fill="${color}"/>`;
const truck = (x: number, color: string) =>
  `<rect x="${x - 24}" y="38" width="30" height="22" fill="${color}"/><rect x="${x + 8}" y="45" width="14" height="15" rx="2" fill="${color}"/>` +
  `<circle cx="${x - 16}" cy="63" r="5" fill="${color}"/><circle cx="${x + 14}" cy="63" r="5" fill="${color}"/>`;

export const SIGNS: readonly SignDef[] = [
  { code: '1.8', title: 'Светофорное регулирование', group: 'Предупреждающие',
    draw: () => triangle(`<rect x="41" y="34" width="18" height="44" rx="5" fill="${BLACK}"/><circle cx="50" cy="43" r="5.5" fill="${RED}"/><circle cx="50" cy="56" r="5.5" fill="${YELLOW}"/><circle cx="50" cy="69" r="5.5" fill="#21B04B"/>`) },
  { code: '1.11.1', title: 'Опасный поворот', group: 'Предупреждающие',
    draw: () => triangle(`<path d="M44 78 V60 Q44 48 56 46" fill="none" stroke="${BLACK}" stroke-width="7"/><polygon points="68,45 54,36 55,56" fill="${BLACK}"/>`) },
  { code: '1.17', title: 'Искусственная неровность', group: 'Предупреждающие',
    draw: () => triangle(`<path d="M22 74 H37 Q50 52 63 74 H78" fill="none" stroke="${BLACK}" stroke-width="6"/>`) },
  { code: '1.33', title: 'Прочие опасности', group: 'Предупреждающие',
    draw: () => triangle(`<rect x="46" y="36" width="8" height="27" rx="3" fill="${BLACK}"/><circle cx="50" cy="72" r="5" fill="${BLACK}"/>`) },
  { code: '2.1', title: 'Главная дорога', group: 'Приоритета',
    draw: () => `<rect x="17" y="17" width="66" height="66" transform="rotate(45 50 50)" fill="${WHITE}" stroke="#555" stroke-width="1.5"/><rect x="27" y="27" width="46" height="46" transform="rotate(45 50 50)" fill="${YELLOW}"/>` },
  { code: '2.2', title: 'Конец главной дороги', group: 'Приоритета',
    draw: () => `<rect x="17" y="17" width="66" height="66" transform="rotate(45 50 50)" fill="${WHITE}" stroke="#555" stroke-width="1.5"/><rect x="27" y="27" width="46" height="46" transform="rotate(45 50 50)" fill="${YELLOW}"/>` +
      [-8, 0, 8].map((d) => `<line x1="${32 + d}" y1="${68 + d}" x2="${68 + d}" y2="${32 + d}" stroke="${BLACK}" stroke-width="3"/>`).join('') },
  { code: '2.3.1', title: 'Пересечение со второстепенной дорогой', group: 'Приоритета',
    draw: () => triangle(`<rect x="45" y="33" width="10" height="46" fill="${BLACK}"/><rect x="27" y="55" width="46" height="6" fill="${BLACK}"/>`) },
  { code: '2.4', title: 'Уступите дорогу', group: 'Приоритета',
    draw: () => `<path d="M7 15 H93 L50 91 Z" fill="${WHITE}" stroke="${RED}" stroke-width="8" stroke-linejoin="round"/>` },
  { code: '2.5', title: 'Движение без остановки запрещено', group: 'Приоритета',
    draw: () => `<polygon points="67.6,7.5 92.5,32.4 92.5,67.6 67.6,92.5 32.4,92.5 7.5,67.6 7.5,32.4 32.4,7.5" fill="${RED}" stroke="${WHITE}" stroke-width="3"/>${text('STOP', 25, WHITE)}` },
  { code: '3.1', title: 'Въезд запрещён', group: 'Запрещающие',
    draw: () => `<circle cx="50" cy="50" r="46" fill="${RED}" stroke="${WHITE}" stroke-width="2"/><rect x="17" y="42" width="66" height="16" fill="${WHITE}"/>` },
  { code: '3.2', title: 'Движение запрещено', group: 'Запрещающие', draw: () => roundProhibit('') },
  { code: '3.4', title: 'Движение грузовых автомобилей запрещено', group: 'Запрещающие', draw: () => roundProhibit(truck(50, BLACK)) },
  { code: '3.11', title: 'Ограничение массы', group: 'Запрещающие', defaultValue: '8 т', draw: (v) => roundProhibit(text(v, 26)) },
  { code: '3.13', title: 'Ограничение высоты', group: 'Запрещающие', defaultValue: '3,5 м',
    draw: (v) => roundProhibit(`<polygon points="40,18 60,18 50,28" fill="${BLACK}"/><polygon points="40,82 60,82 50,72" fill="${BLACK}"/>${text(v, 20)}`) },
  { code: '3.18.1', title: 'Поворот направо запрещён', group: 'Запрещающие', draw: () => roundProhibit(arrowRight(BLACK) + slash) },
  { code: '3.18.2', title: 'Поворот налево запрещён', group: 'Запрещающие', draw: () => roundProhibit(arrowLeft(BLACK) + slash) },
  { code: '3.19', title: 'Разворот запрещён', group: 'Запрещающие',
    draw: () => roundProhibit(`<path d="M60 80 V46 Q60 30 46 30 Q34 30 34 46 V54" fill="none" stroke="${BLACK}" stroke-width="8"/><polygon points="34,70 22,52 46,52" fill="${BLACK}"/>${slash}`) },
  { code: '3.20', title: 'Обгон запрещён', group: 'Запрещающие', draw: () => roundProhibit(car(35, RED) + car(65, BLACK)) },
  { code: '3.22', title: 'Обгон грузовым автомобилям запрещён', group: 'Запрещающие',
    draw: () => roundProhibit(`<g transform="translate(-10 0) scale(0.75) translate(16 17)">${truck(50, RED)}</g>${car(68, BLACK)}`) },
  { code: '3.24', title: 'Ограничение максимальной скорости', group: 'Запрещающие', defaultValue: '60', draw: (v) => roundProhibit(text(v, 38)) },
  { code: '3.25', title: 'Конец зоны ограничения максимальной скорости', group: 'Запрещающие', defaultValue: '60', draw: (v) => endZone(text(v, 36, '#6B6B6B')) },
  { code: '3.27', title: 'Остановка запрещена', group: 'Запрещающие',
    draw: () => roundProhibit(`<line x1="21" y1="21" x2="79" y2="79" stroke="${RED}" stroke-width="8"/><line x1="79" y1="21" x2="21" y2="79" stroke="${RED}" stroke-width="8"/>`, BLUE) },
  { code: '3.28', title: 'Стоянка запрещена', group: 'Запрещающие', draw: () => roundProhibit(slash, BLUE) },
  { code: '3.31', title: 'Конец зоны всех ограничений', group: 'Запрещающие', draw: () => endZone('') },
  { code: '4.1.1', title: 'Движение прямо', group: 'Предписывающие', draw: () => blueRound(arrowUp(WHITE)) },
  { code: '4.1.2', title: 'Движение направо', group: 'Предписывающие', draw: () => blueRound(arrowRight(WHITE)) },
  { code: '4.1.4', title: 'Движение прямо или направо', group: 'Предписывающие',
    draw: () => blueRound(`<rect x="37" y="36" width="10" height="46" fill="${WHITE}"/><polygon points="42,14 57,38 27,38" fill="${WHITE}"/><path d="M42 66 Q42 52 56 52 H64" fill="none" stroke="${WHITE}" stroke-width="10"/><polygon points="82,52 62,38 62,66" fill="${WHITE}"/>`) },
  { code: '4.3', title: 'Круговое движение', group: 'Предписывающие',
    draw: () => blueRound(`<circle cx="50" cy="50" r="22" fill="none" stroke="${WHITE}" stroke-width="7"/>` +
      [0, -120, -240].map((a) => `<polygon points="37,28 53,17 53,39" fill="${WHITE}" transform="rotate(${a} 50 50)"/>`).join('')) },
  { code: '5.1', title: 'Автомагистраль', group: 'Особых предписаний',
    draw: () => square(`<rect x="16" y="34" width="68" height="8" fill="${WHITE}"/><rect x="24" y="42" width="7" height="16" fill="${WHITE}"/><rect x="69" y="42" width="7" height="16" fill="${WHITE}"/>` +
      `<path d="M38 84 L46 52 M62 84 L54 52" stroke="${WHITE}" stroke-width="5"/><line x1="50" y1="56" x2="50" y2="62" stroke="${WHITE}" stroke-width="3"/><line x1="50" y1="70" x2="50" y2="80" stroke="${WHITE}" stroke-width="3"/>`, GREEN) },
  { code: '5.5', title: 'Дорога с односторонним движением', group: 'Особых предписаний', draw: () => square(arrowUp(WHITE)) },
  { code: '5.19.1', title: 'Пешеходный переход', group: 'Особых предписаний',
    draw: () => square(`<path d="M50 12 L88 84 H12 Z" fill="${WHITE}"/>` +
      `<circle cx="52" cy="36" r="5" fill="${BLACK}"/><path d="M51 42 L47 58 L40 70 M47 58 L56 70 M50 46 L41 52 M50 46 L59 52" stroke="${BLACK}" stroke-width="4.5" stroke-linecap="round" fill="none"/>` +
      [24, 38, 52, 66].map((x) => `<rect x="${x}" y="74" width="9" height="6" fill="${BLACK}"/>`).join('')) },
  { code: '5.23.1', title: 'Начало населённого пункта', group: 'Особых предписаний', defaultValue: 'ВОЛОГДА',
    draw: (v) => `<rect x="3" y="24" width="94" height="52" rx="5" fill="${WHITE}" stroke="${BLACK}" stroke-width="3"/>${text(v, 15)}` },
  { code: '5.24.1', title: 'Конец населённого пункта', group: 'Особых предписаний', defaultValue: 'ВОЛОГДА',
    draw: (v) => `<rect x="3" y="24" width="94" height="52" rx="5" fill="${WHITE}" stroke="${BLACK}" stroke-width="3"/>${text(v, 15)}<line x1="8" y1="72" x2="92" y2="28" stroke="${RED}" stroke-width="5"/>` },
  { code: '6.4', title: 'Парковка (парковочное место)', group: 'Информационные', draw: () => square(text('P', 66, WHITE, 52)) },
];

const BY_CODE = new Map(SIGNS.map((s) => [s.code, s]));

export function parseSignSpec(spec: string): { code: string; value?: string } {
  const i = spec.indexOf(':');
  return i < 0 ? { code: spec } : { code: spec.slice(0, i), value: spec.slice(i + 1) };
}

export function hasSign(spec: string): boolean {
  return BY_CODE.has(parseSignSpec(spec).code);
}

export function signTitle(spec: string): string {
  const { code } = parseSignSpec(spec);
  return BY_CODE.get(code)?.title ?? `Знак ${code}`;
}

/** SVG-разметка знака. Неизвестный код рисуется заглушкой с номером — интерфейс не ломается. */
export function renderSign(spec: string, size = 96): string {
  const { code, value } = parseSignSpec(spec);
  const def = BY_CODE.get(code);
  const label = escapeXml(`${code} «${def?.title ?? 'Знак'}»`);
  const body = def
    ? def.draw(value ?? def.defaultValue ?? '')
    : `<rect x="4" y="4" width="92" height="92" rx="8" fill="#EEE" stroke="#999"/>${text(code, 18, '#666')}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="${label}"><title>${label}</title>${body}</svg>`;
}

// ---------- Официальный справочник знаков (картинки из набора билетов) ----------

export interface CatalogSign {
  readonly code: string;
  readonly title: string;
  readonly image: string;
  readonly description: string;
}

export interface CatalogGroup {
  readonly group: string;
  readonly items: readonly CatalogSign[];
}

/** Разбор недоверенного JSON справочника: допускаются только относительные пути к картинкам. */
export function parseSignCatalog(raw: unknown): CatalogGroup[] {
  const groups = (raw as { groups?: unknown })?.groups;
  if (!Array.isArray(groups)) throw new Error('Справочник знаков повреждён');
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return groups.map((g) => ({
    group: str(g?.group),
    items: (Array.isArray(g?.items) ? g.items : [])
      .map((i: Record<string, unknown>) => ({ code: str(i.code), title: str(i.title), image: str(i.image), description: str(i.description) }))
      .filter((i: CatalogSign) => i.code && i.title && /^\.\/images\/[\w./-]+\.(svg|png|jpe?g)$/.test(i.image)),
  })).filter((g) => g.group && g.items.length > 0);
}
