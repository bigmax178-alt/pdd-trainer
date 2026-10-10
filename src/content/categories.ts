import { BANK_IDS, type BankId, type CategoryCode } from '../core/types.ts';

/**
 * Комплекты экзаменационных билетов МВД. Все категории внутри комплекта сдают одни и те же билеты:
 * кто получает A и B одновременно, учит один комплект ABM. Комплекты совпадают примерно на три четверти,
 * в CD больше вопросов о грузовых автомобилях, автобусах и маршрутном транспорте.
 */
export interface TicketSet {
  readonly bank: BankId;
  readonly code: 'ABM' | 'CD';
  /** Коротко для шапки: «A · B · M». */
  readonly short: string;
  readonly vehicles: string;
  /** Категории, для которых комплект установлен официально. */
  readonly categories: readonly CategoryCode[];
}

export const TICKET_SETS: readonly TicketSet[] = [
  { bank: 'AB', code: 'ABM', short: 'A · B · M', vehicles: 'Мотоциклы, легковые, мопеды, трициклы и квадрициклы', categories: ['A', 'B', 'M', 'A1', 'B1'] },
  { bank: 'CD', code: 'CD', short: 'C · D', vehicles: 'Грузовые автомобили и автобусы', categories: ['C', 'D', 'C1', 'D1'] },
];

/**
 * Теоретический экзамен для этих категорий обязателен (Правила проведения экзаменов, утв. ПП РФ № 1097, п. 9),
 * но комплект билетов для них в открытых нормативных источниках не указан — пользователю предлагается уточнить в автошколе.
 */
export const UNCONFIRMED_CATEGORIES: readonly CategoryCode[] = ['BE', 'CE', 'C1E', 'DE', 'D1E', 'Tm', 'Tb'];

export function isBankId(value: unknown): value is BankId {
  return BANK_IDS.includes(value as BankId);
}

export function ticketSet(bank: BankId): TicketSet {
  const set = TICKET_SETS.find((t) => t.bank === bank);
  if (!set) throw new Error(`Неизвестный комплект билетов ${bank}`);
  return set;
}

/** Поиск комплекта по коду «ABM»/«CD» или идентификатору банка «AB»/«CD». */
export function findTicketSet(value: unknown): TicketSet | undefined {
  return TICKET_SETS.find((t) => t.code === value || t.bank === value);
}

export interface CategoryInfo {
  readonly code: CategoryCode;
  readonly title: string;
  readonly description: string;
  /** Комплект билетов: официальный, а для UNCONFIRMED_CATEGORIES — комплект базовой категории по умолчанию. */
  readonly bank: BankId;
  readonly bankConfirmed: boolean;
}

/** Категории и подкатегории по ст. 25 Федерального закона «О безопасности дорожного движения». */
const RAW: readonly Omit<CategoryInfo, 'bankConfirmed'>[] = [
  { code: 'M', bank: 'AB', title: 'Мопеды', description: 'Мопеды и лёгкие квадрициклы' },
  { code: 'A', bank: 'AB', title: 'Мотоциклы', description: 'Мотоциклы' },
  { code: 'A1', bank: 'AB', title: 'Лёгкие мотоциклы', description: 'Мотоциклы с рабочим объёмом двигателя до 125 см³ и мощностью до 11 кВт' },
  { code: 'B', bank: 'AB', title: 'Легковые', description: 'Автомобили до 3,5 т и не более 8 мест для сидения, помимо места водителя' },
  { code: 'B1', bank: 'AB', title: 'Трициклы и квадрициклы', description: 'Трициклы и квадрициклы' },
  { code: 'BE', bank: 'AB', title: 'B + прицеп', description: 'Автомобили категории B с прицепом массой более 750 кг' },
  { code: 'C', bank: 'CD', title: 'Грузовые', description: 'Автомобили с разрешённой максимальной массой более 3,5 т (кроме категории D)' },
  { code: 'C1', bank: 'CD', title: 'Средние грузовые', description: 'Автомобили массой от 3,5 до 7,5 т (кроме категории D)' },
  { code: 'CE', bank: 'CD', title: 'C + прицеп', description: 'Автомобили категории C с прицепом массой более 750 кг' },
  { code: 'C1E', bank: 'CD', title: 'C1 + прицеп', description: 'Автомобили подкатегории C1 с прицепом массой более 750 кг' },
  { code: 'D', bank: 'CD', title: 'Автобусы', description: 'Автомобили для перевозки пассажиров с числом мест для сидения более 8, помимо места водителя' },
  { code: 'D1', bank: 'CD', title: 'Малые автобусы', description: 'Автобусы с числом мест для сидения от 9 до 16, помимо места водителя' },
  { code: 'DE', bank: 'CD', title: 'D + прицеп', description: 'Автобусы категории D с прицепом массой более 750 кг' },
  { code: 'D1E', bank: 'CD', title: 'D1 + прицеп', description: 'Автобусы подкатегории D1 с прицепом массой более 750 кг' },
  { code: 'Tm', bank: 'CD', title: 'Трамваи', description: 'Трамваи' },
  { code: 'Tb', bank: 'CD', title: 'Троллейбусы', description: 'Троллейбусы' },
];

export const CATEGORIES: readonly CategoryInfo[] = RAW.map((c) => ({ ...c, bankConfirmed: !UNCONFIRMED_CATEGORIES.includes(c.code) }));

export function categoryInfo(code: CategoryCode): CategoryInfo {
  const info = CATEGORIES.find((c) => c.code === code);
  if (!info) throw new Error(`Неизвестная категория ${code}`);
  return info;
}

export function isCategoryCode(value: unknown): value is CategoryCode {
  return CATEGORIES.some((c) => c.code === value);
}
