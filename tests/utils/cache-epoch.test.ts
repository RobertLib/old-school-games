import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db from "../../db.ts";
import logger from "../../utils/logger.ts";
import { TtlCache } from "../../utils/cache.ts";
import {
  EPOCH_CHECK_INTERVAL_MS,
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

  it("is an express middleware that always continues", async () => {
    mockDb.query.mockRejectedValueOnce(new Error("down"));
    const next = vi.fn();

    await cacheEpochSync({} as any, {} as any, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
