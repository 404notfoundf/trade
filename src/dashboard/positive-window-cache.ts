import type { PositiveWindow } from "../direct-pool/windows.js";

type CacheEntry = { expiresAt: number; windows: PositiveWindow[] };

const ttlMs = 10_000;
const maxEntries = 16;

export function createPositiveWindowCache(now: () => number = Date.now) {
  const entries = new Map<string, CacheEntry>();

  return {
    get(key: string): PositiveWindow[] | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.windows;
    },
    set(key: string, windows: PositiveWindow[]): void {
      const at = now();
      for (const [cachedKey, entry] of entries) if (entry.expiresAt <= at) entries.delete(cachedKey);
      entries.delete(key);
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(key, { expiresAt: at + ttlMs, windows });
    },
  };
}

export const positiveWindowCache = createPositiveWindowCache();
