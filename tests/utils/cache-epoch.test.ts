import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db from "../../db.ts";
import logger from "../../utils/logger.ts";
import { TtlCache } from "../../utils/cache.ts";
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
  });

  afterEach(() => {
    cache.clear();
  });

  async function warm(): Promise<void> {
    await cache.get("k", 60_000, async () => "v");
    expect(cache.has("k")).toBe(true);
  }

  it("leaves the caches alone the first time it reads the counter", async () => {
    await warm();
    mockDb.query.mockResolvedValueOnce({ rows: [{ epoch: "5" }] } as any);

    await syncCacheEpoch(1_000);

    expect(cache.has("k")).toBe(true);
  });

  it("drops every cache when the counter has moved", async () => {
    await warm();
    mockDb.query.mockResolvedValueOnce({ rows: [{ epoch: "5" }] } as any);
    await syncCacheEpoch(1_000);

    mockDb.query.mockResolvedValueOnce({ rows: [{ epoch: "6" }] } as any);
    await syncCacheEpoch(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(cache.has("k")).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("moved from 5 to 6"),
    );
  });

  it("keeps the caches when the counter has not moved", async () => {
    await warm();
    mockDb.query.mockResolvedValue({ rows: [{ epoch: "5" }] } as any);
    await syncCacheEpoch(1_000);
    await syncCacheEpoch(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(cache.has("k")).toBe(true);
  });

  it("reads the counter at most once per interval", async () => {
    mockDb.query.mockResolvedValue({ rows: [{ epoch: "1" }] } as any);

    await syncCacheEpoch(1_000);
    await syncCacheEpoch(1_000 + EPOCH_CHECK_INTERVAL_MS - 1);
    await syncCacheEpoch(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it("shares one query between concurrent callers", async () => {
    mockDb.query.mockResolvedValue({ rows: [{ epoch: "1" }] } as any);

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
    mockDb.query.mockResolvedValueOnce({ rows: [] } as any);

    await syncCacheEpoch(1_000);

    expect(cache.has("k")).toBe(true);
  });

  // The process that made the write has just rebuilt its own caches; it must
  // not throw them away again when it next sees the number it moved.
  it("adopts the value it bumped to, so it does not clear itself", async () => {
    await warm();
    mockDb.query.mockResolvedValueOnce({ rows: [{ epoch: "5" }] } as any);
    await syncCacheEpoch(1_000);

    mockDb.query.mockResolvedValueOnce({ rows: [{ epoch: "6" }] } as any);
    await bumpCacheEpoch();

    expect(mockDb.query).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE "cache_epochs"'),
    );

    mockDb.query.mockResolvedValueOnce({ rows: [{ epoch: "6" }] } as any);
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

    mockDb.query.mockResolvedValueOnce({ rows: [{ epoch: "1" }] } as any);
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

    mockDb.query.mockResolvedValueOnce({ rows: [{ epoch: "6" }] } as any);
    await bumpCacheEpoch();

    // The stale read landing after the bump.
    mockDb.query.mockResolvedValueOnce({ rows: [{ epoch: "5" }] } as any);
    await syncCacheEpoch(1_000);

    // ...and the next check, which sees the number the bump wrote.
    mockDb.query.mockResolvedValueOnce({ rows: [{ epoch: "6" }] } as any);
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
});
