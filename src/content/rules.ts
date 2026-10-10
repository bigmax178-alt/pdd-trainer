/**
 * Текст ПДД для переходов из пояснений («п. 13.11») и раздела «Правила».
 * Данные загружаются из content/rules.json (готовит scripts/fetch-rules.ts из официального источника).
 */
export interface RuleItem {
  readonly num: string;
  readonly text: string;
}

export interface RuleSection {
  readonly num: string;
  readonly title: string;
  readonly items: readonly RuleItem[];
}

export interface RuleBook {
  readonly source: string;
  readonly edition: string;
  readonly sections: readonly RuleSection[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function parseRuleBook(raw: unknown): RuleBook {
  const r = raw as Partial<RuleBook> | null;
  if (!r || !Array.isArray(r.sections)) throw new Error('Файл правил повреждён');
  const sections: RuleSection[] = r.sections
    .map((s) => ({
      num: str((s as RuleSection).num),
      title: str((s as RuleSection).title),
      items: (Array.isArray((s as RuleSection).items) ? (s as RuleSection).items : [])
        .map((i) => ({ num: str(i.num), text: str(i.text) }))
        .filter((i) => i.num && i.text),
    }))
    .filter((s) => s.num && s.title && s.items.length);
  return { source: str(r.source), edition: str(r.edition), sections };
}

export class RuleIndex {
  readonly book: RuleBook;
  private readonly items = new Map<string, { item: RuleItem; section: RuleSection }>();

  constructor(book: RuleBook) {
    this.book = book;
    for (const section of book.sections) for (const item of section.items) this.items.set(item.num, { item, section });
  }

  /** Пункт по номеру («13.11»); для подпункта («2.1.1») при отсутствии — ближайший родитель («2.1»). */
  find(num: string): { item: RuleItem; section: RuleSection } | undefined {
    let key = num.trim();
    while (key) {
      const hit = this.items.get(key);
      if (hit) return hit;
      const i = key.lastIndexOf('.');
      if (i < 0) return undefined;
      key = key.slice(0, i);
    }
    return undefined;
  }

  has(num: string): boolean {
    return this.find(num) !== undefined;
  }
}

/** Ссылка на пункт ПДД, которую можно открыть: «13.11», «2.1.1». Разделы приложений («Приложение 2») — нет. */
export const RULE_REF = /^\d{1,2}(\.\d{1,2}){1,2}$/;
