/**
 * Shared in-flight + short-TTL cache for catalog GETs (`/api/models`,
 * `/api/cards`, …) so sibling components on one screen share a request.
 */
export const CATALOG_TTL_MS = 60_000;
/** Failed / empty responses are retried soon instead of being pinned. */
export const EMPTY_RESULT_TTL_MS = 2_000;

type Entry = {
  promise: Promise<unknown>;
  settledAt: number | null;
  empty: boolean;
};

const entries = new Map<string, Entry>();

function isEmptyResult(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0);
}

export function cachedRequest<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  emptyTtlMs: number = EMPTY_RESULT_TTL_MS,
): Promise<T> {
  const existing = entries.get(key);
  if (existing) {
    if (existing.settledAt === null) return existing.promise as Promise<T>;
    const ttl = existing.empty ? emptyTtlMs : ttlMs;
    if (performance.now() - existing.settledAt < ttl) {
      return existing.promise as Promise<T>;
    }
  }

  const entry: Entry = {
    promise: Promise.resolve(),
    settledAt: null,
    empty: false,
  };
  entry.promise = fn().then(
    (value) => {
      entry.settledAt = performance.now();
      entry.empty = isEmptyResult(value);
      return value;
    },
    (error: unknown) => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    },
  );
  entries.set(key, entry);
  return entry.promise as Promise<T>;
}

/** Drop one cached key (or all) so the next call refetches. */
export function clearCachedRequest(key?: string) {
  if (key === undefined) entries.clear();
  else entries.delete(key);
}
