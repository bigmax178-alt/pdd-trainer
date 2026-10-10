/**
 * Детерминированный ГСЧ (mulberry32). Состояние — одно 32-битное число,
 * поэтому его можно сохранить в состоянии экзамена и продолжить ту же последовательность
 * после перезагрузки страницы или на сервере. Это делает экзамены воспроизводимыми в тестах.
 */
export interface Rng {
  /** Равномерное число в [0, 1). */
  next(): number;
  /** Целое в [0, max). */
  int(max: number): number;
  /** Текущее состояние для сериализации. */
  state(): number;
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max) => Math.floor(next() * max),
    state: () => s,
  };
}

/** Перемешивание Фишера–Йетса, возвращает новый массив. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Стабильный 32-битный хеш строки (FNV-1a) — для сидов из идентификаторов. */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Случайный сид из системного источника (не для криптографии). */
export function randomSeed(): number {
  return (Math.random() * 4294967296) >>> 0;
}
