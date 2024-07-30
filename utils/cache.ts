/**
 * A small time-to-live cache for the handful of lists every page renders.
 *
 * It stores the in-flight promise rather than the resolved value, so the
 * requests that arrive while a cold entry is still loading wait for that one
 * query instead of each firing their own. A rejected load is dropped rather
 * than remembered — otherwise a single blip would serve an error for the whole
 * lifetime of the entry.
 *
 * The time to live is counted from the moment a load resolves, not from when
 * it started, so an entry is held for the full TTL however long it took to
 * build — and a load is never evicted out from under itself. See get().
 */
interface CacheEntry {
  value: Promise<unknown>;
  timer?: NodeJS.Timeout;
}

/**
 * Every cache this process holds, so utils/cache-epoch.ts can drop them all
 * at once when another machine has written something. Registered on
 * construction rather than by hand at each site, because a cache that is
 * forgotten here is one that goes on serving a deleted game for its TTL.
 */
const REGISTRY = new Set<TtlCache>();

export function clearAllCaches(): void {
  for (const cache of REGISTRY) cache.clear();
}

export class TtlCache {
  #entries = new Map<string, CacheEntry>();

  constructor() {
    REGISTRY.add(this);
  }

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const existing = this.#entries.get(key);

    if (existing) {
      return existing.value as Promise<T>;
    }

    const value = load();
    const entry: CacheEntry = { value };

    this.#entries.set(key, entry);

    value.then(
      () => {
        // Started here rather than beside the set() above, so the lifetime is
        // measured from when the value existed rather than from when it was
        // asked for. A load slower than its own TTL — a full sitemap build on
        // a grown catalogue — used to be evicted while still in flight, so
        // the next request began a second build of the very thing already
        // being built, and neither was ever cached.
        //
        // An entry with no timer yet is one still loading, which is exactly
        // when it should be held: that is what makes the requests arriving
        // during a cold build share it.
        //
        // Guarded, because the entry may already have been dropped by hand —
        // a write clearing the sitemap while it builds — and re-arming a timer
        // for it would leave a stray eviction behind.
        if (this.#entries.get(key) !== entry) return;

        // unref'd so a pending expiry cannot by itself hold the process open.
        entry.timer = setTimeout(() => this.#evict(key, entry), ttlMs);
        entry.timer.unref?.();
      },
      () => this.#evict(key, entry),
    );

    return value;
  }

  /**
   * Removes `key`, but only while it still holds `entry`.
   *
   * A load can reject long after its own entry expired and was replaced by a
   * fresh one — the rejection is not on any clock this cache controls. An
   * unguarded delete would then throw away perfectly good data on behalf of a
   * result nobody is waiting for any more, and the next request would pay for
   * a reload it did not need.
   */
  #evict(key: string, entry: CacheEntry): void {
    if (this.#entries.get(key) !== entry) return;

    this.delete(key);
  }

  /** Whether a key is currently held — a stored `null` counts as held. */
  has(key: string): boolean {
    return this.#entries.has(key);
  }

  delete(key: string): void {
    const entry = this.#entries.get(key);

    if (!entry) return;

    clearTimeout(entry.timer);
    this.#entries.delete(key);
  }

  clear(): void {
    for (const entry of this.#entries.values()) {
      clearTimeout(entry.timer);
    }

    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
