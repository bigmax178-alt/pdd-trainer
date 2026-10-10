import type { KeyValueStore } from '../app/ports.ts';

export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, string>();
  get(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.data.set(key, value);
  }
  remove(key: string): void {
    this.data.delete(key);
  }
}

/**
 * Обёртка над Web Storage. Доступ к localStorage может бросать исключения (приватный режим,
 * заблокированные cookies, переполнение квоты) — тогда данные продолжают жить в памяти,
 * а приложение работает без сбоев.
 */
export class BrowserStore implements KeyValueStore {
  private readonly fallback = new MemoryStore();
  private readonly storage: Storage | null;
  /** true, если данные сохраняются только до закрытия вкладки. */
  degraded = false;

  constructor(getStorage: () => Storage | null) {
    let storage: Storage | null = null;
    try {
      storage = getStorage();
      const probe = '__pdd_probe__';
      storage?.setItem(probe, '1');
      storage?.removeItem(probe);
    } catch {
      storage = null;
    }
    this.storage = storage;
    this.degraded = storage === null;
  }

  get(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? this.fallback.get(key);
    } catch {
      return this.fallback.get(key);
    }
  }

  set(key: string, value: string): void {
    this.fallback.set(key, value);
    try {
      this.storage?.setItem(key, value);
    } catch {
      this.degraded = true;
    }
  }

  remove(key: string): void {
    this.fallback.remove(key);
    try {
      this.storage?.removeItem(key);
    } catch {
      /* данные останутся только в памяти */
    }
  }
}
