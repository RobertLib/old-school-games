import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db from "../../db.ts";
import logger from "../../utils/logger.ts";
import { TtlCache } from "../../utils/cache.ts";
import {
  LATEST_COMMENTS_KEY,
  sidebarCache,
} from "../../utils/sidebar-cache.ts";
import {
  EPOCH_CHECK_INTERVAL_MS,
  FAILURE_BACKOFF_MS,
  SYNC_TIMEOUT_MS,
  bumpCacheEpoch,
  cacheEpochSync,
  resetCacheEpochForTests,
  syncCacheEpoch,
} from "../../utils/cache-epoch.ts";

vi.mock("../../db", () => ({
  default: { query: vi.fn() },
}));

vi.mock("../../utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockDb = vi.mocked(db);

/**
 * The shared counter every machine compares against — see
 * utils/cache-epoch.ts. Every cache here is a Map in one process's memory,
 * so a write on one machine used to leave every other machine serving what
 * it had deleted for the length of the TTL.
 */
describe("cache epoch", () => {
  let cache: TtlCache;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCacheEpochForTests();
    cache = new TtlCache();
    sidebarCache.clear();
  });

  afterEach(() => {
    cache.clear();
    sidebarCache.clear();
  });

  /**
   * One row per scope, which is the shape 0039 gave the table. The counters
   * used to be one row for the whole app, so a posted comment — the most
   * frequent write on the site — made every other machine drop everything it
   * held, the sitemap included, while the machine that took the comment had
   * dropped one sidebar entry.
   */
  const epochs = (rows: Record<string, number>) =>
    ({
      rows: Object.entries(rows).map(([scope, epoch]) => ({
        scope,
        epoch: String(epoch),
      })),
    }) as any;

  async function warm(): Promise<void> {
    await cache.get("k", 60_000, async () => "v");
    expect(cache.has("k")).toBe(true);
  }

  /** A held "Latest comments" entry, so dropping it is observable. */
  async function warmCommentsWidget(): Promise<void> {
    await sidebarCache.get(LATEST_COMMENTS_KEY, 60_000, async () => []);
    expect(sidebarCache.has(LATEST_COMMENTS_KEY)).toBe(true);
  }

  it("leaves the caches alone the first time it reads the counter", async () => {
    await warm();
    mockDb.query.mockResolvedValueOnce(epochs({ all: 5 }));

    await syncCacheEpoch(1_000);

    expect(cache.has("k")).toBe(true);
  });

  it("drops every cache when the counter has moved", async () => {
    await warm();
    mockDb.query.mockResolvedValueOnce(epochs({ all: 5 }));
    await syncCacheEpoch(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ all: 6 }));
    await syncCacheEpoch(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(cache.has("k")).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("moved for all"),
    );
  });

  it("keeps the caches when the counter has not moved", async () => {
    await warm();
    mockDb.query.mockResolvedValue(epochs({ all: 5 }));
    await syncCacheEpoch(1_000);
    await syncCacheEpoch(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(cache.has("k")).toBe(true);
  });

  it("reads the counter at most once per interval", async () => {
    mockDb.query.mockResolvedValue(epochs({ all: 1 }));

    await syncCacheEpoch(1_000);
    await syncCacheEpoch(1_000 + EPOCH_CHECK_INTERVAL_MS - 1);
    await syncCacheEpoch(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it("shares one query between concurrent callers", async () => {
    mockDb.query.mockResolvedValue(epochs({ all: 1 }));

    await Promise.all([syncCacheEpoch(1_000), syncCacheEpoch(1_000)]);

    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("logs and carries on when the counter cannot be read", async () => {
    await warm();
    mockDb.query.mockRejectedValueOnce(new Error("down"));

    await expect(syncCacheEpoch(1_000)).resolves.toBeUndefined();

    expect(cache.has("k")).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      "Could not read the cache epoch:",
      expect.any(Error),
    );
  });

  it("copes with a database that has no counter row yet", async () => {
    await warm();
    mockDb.query.mockResolvedValueOnce(epochs({}));

    await syncCacheEpoch(1_000);

    expect(cache.has("k")).toBe(true);
  });

  // The process that made the write has just rebuilt its own caches; it must
  // not throw them away again when it next sees the number it moved.
  it("adopts the value it bumped to, so it does not clear itself", async () => {
    await warm();
    mockDb.query.mockResolvedValueOnce(epochs({ all: 5 }));
    await syncCacheEpoch(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ all: 6 }));
    await bumpCacheEpoch();

    expect(mockDb.query).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE "cache_epochs"'),
      ["all"],
    );

    mockDb.query.mockResolvedValueOnce(epochs({ all: 6 }));
    await syncCacheEpoch(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(cache.has("k")).toBe(true);
  });

  it("logs and carries on when the bump fails", async () => {
    mockDb.query.mockRejectedValueOnce(new Error("down"));

    await expect(bumpCacheEpoch()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      "Could not bump the cache epoch:",
      expect.any(Error),
    );
  });

  /**
   * A read that failed is not a read. The interval used to be charged
   * whether or not the query answered, so one failure against a database
   * that was away also bought ten seconds of not looking again — and a
   * machine coming back up went unnoticed for the rest of that window.
   */
  it("retries sooner after a failure than after a successful read", async () => {
    mockDb.query.mockRejectedValueOnce(new Error("down"));
    await syncCacheEpoch(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ all: 1 }));
    await syncCacheEpoch(1_000 + FAILURE_BACKOFF_MS);

    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it("still shares one attempt while the backoff holds", async () => {
    mockDb.query.mockRejectedValueOnce(new Error("down"));
    await syncCacheEpoch(1_000);

    await syncCacheEpoch(1_000 + FAILURE_BACKOFF_MS - 1);

    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  /**
   * A bump and a read are two statements on two connections and nothing
   * orders them, so a SELECT issued before the UPDATE can resolve after it
   * carrying the older number. Adopting that number meant the next check saw
   * the counter "move" again and threw away caches this process had just
   * rebuilt.
   */
  it("never adopts a number below the one it has already seen", async () => {
    await warm();

    mockDb.query.mockResolvedValueOnce(epochs({ all: 6 }));
    await bumpCacheEpoch();

    // The stale read landing after the bump.
    mockDb.query.mockResolvedValueOnce(epochs({ all: 5 }));
    await syncCacheEpoch(1_000);

    // ...and the next check, which sees the number the bump wrote.
    mockDb.query.mockResolvedValueOnce(epochs({ all: 6 }));
    await syncCacheEpoch(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(cache.has("k")).toBe(true);
    expect(logger.info).not.toHaveBeenCalled();
  });

  /**
   * With Postgres unreachable the query does not fail quickly — it waits for
   * a connection the pool cannot produce — and this middleware sits above
   * every page. The one request per interval that ran the check was the one
   * request per interval that hung.
   */
  it("serves the page rather than waiting out an unreachable database", async () => {
    vi.useFakeTimers();

    try {
      mockDb.query.mockImplementation(() => new Promise(() => {}) as any);

      const next = vi.fn();
      const done = cacheEpochSync({} as any, {} as any, next);

      await vi.advanceTimersByTimeAsync(SYNC_TIMEOUT_MS);
      await done;

      expect(next).toHaveBeenCalledTimes(1);
    } finally {
      mockDb.query.mockReset();
      vi.useRealTimers();
    }
  });

  it("is an express middleware that always continues", async () => {
    mockDb.query.mockRejectedValueOnce(new Error("down"));
    const next = vi.fn();

    await cacheEpochSync({} as any, {} as any, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  /**
   * The point of the scopes. A comment write drops one sidebar entry on the
   * machine that takes it, so a machine hearing about it must drop that entry
   * and nothing else — the sitemap it is holding is still perfectly correct,
   * and it is cached for a day.
   */
  it("drops only the comments widget when the comments scope moves", async () => {
    await warm();
    await warmCommentsWidget();

    mockDb.query.mockResolvedValueOnce(epochs({ all: 5, comments: 5 }));
    await syncCacheEpoch(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ all: 5, comments: 6 }));
    await syncCacheEpoch(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(sidebarCache.has(LATEST_COMMENTS_KEY)).toBe(false);
    expect(cache.has("k")).toBe(true);
  });

  // ...and the broad scope still means everything, which is what a game or
  // news write legitimately invalidates.
  it("drops every cache when the broad scope moves", async () => {
    await warm();
    await warmCommentsWidget();

    mockDb.query.mockResolvedValueOnce(epochs({ all: 5, comments: 5 }));
    await syncCacheEpoch(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ all: 6, comments: 5 }));
    await syncCacheEpoch(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(cache.has("k")).toBe(false);
    expect(sidebarCache.has(LATEST_COMMENTS_KEY)).toBe(false);
  });

  it("bumps the scope it is given", async () => {
    mockDb.query.mockResolvedValueOnce(epochs({ comments: 2 }));

    await bumpCacheEpoch("comments");

    expect(mockDb.query).toHaveBeenLastCalledWith(
      expect.stringContaining('WHERE "scope" = $1'),
      ["comments"],
    );
  });

  // A narrow bump must not silence the broad scope: the two counters are
  // independent, and a comment posted here says nothing about a game written
  // elsewhere.
  it("still applies a broad move after a local comment bump", async () => {
    await warm();

    mockDb.query.mockResolvedValueOnce(epochs({ all: 5, comments: 5 }));
    await syncCacheEpoch(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ comments: 6 }));
    await bumpCacheEpoch("comments");

    mockDb.query.mockResolvedValueOnce(epochs({ all: 6, comments: 6 }));
    await syncCacheEpoch(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(cache.has("k")).toBe(false);
  });

  /**
   * A row this build has no effect for is another version of the app writing
   * to the same database, which is exactly the situation mid-deploy. It cannot
   * be applied, and adopting the number would mean never applying it once this
   * build does know the scope.
   */
  it("ignores a scope it does not recognise", async () => {
    await warm();

    mockDb.query.mockResolvedValueOnce(epochs({ all: 5, futurething: 5 }));
    await syncCacheEpoch(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ all: 5, futurething: 9 }));
    await syncCacheEpoch(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(cache.has("k")).toBe(true);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
