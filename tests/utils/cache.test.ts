import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TtlCache } from "../../utils/cache.ts";

describe("TtlCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads once and serves the stored value afterwards", async () => {
    const cache = new TtlCache();
    const load = vi.fn().mockResolvedValue("value");

    expect(await cache.get("k", 1000, load)).toBe("value");
    expect(await cache.get("k", 1000, load)).toBe("value");
    expect(load).toHaveBeenCalledTimes(1);
  });

  // The lists are loaded on the way into a page, so a cold cache used to hand
  // every request that arrived during the first query its own copy of it.
  it("collapses concurrent misses onto one load", async () => {
    const cache = new TtlCache();
    const load = vi.fn().mockResolvedValue("value");

    const results = await Promise.all([
      cache.get("k", 1000, load),
      cache.get("k", 1000, load),
      cache.get("k", 1000, load),
    ]);

    expect(results).toEqual(["value", "value", "value"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reloads once the entry has expired", async () => {
    const cache = new TtlCache();
    const load = vi.fn().mockResolvedValue("value");

    await cache.get("k", 1000, load);
    await vi.advanceTimersByTimeAsync(1001);
    await cache.get("k", 1000, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  // A remembered failure would serve the error for the whole lifetime of the
  // entry — six hours, for the footer links.
  it("does not remember a failed load", async () => {
    const cache = new TtlCache();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue("value");

    await expect(cache.get("k", 1000, load)).rejects.toThrow("db down");

    expect(cache.has("k")).toBe(false);
    expect(await cache.get("k", 1000, load)).toBe("value");
  });

  // "no game of the week this week" is a real answer, not a cache miss.
  it("holds a null value rather than reloading it", async () => {
    const cache = new TtlCache();
    const load = vi.fn().mockResolvedValue(null);

    expect(await cache.get("k", 1000, load)).toBeNull();
    expect(await cache.get("k", 1000, load)).toBeNull();
    expect(cache.has("k")).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps entries apart", async () => {
    const cache = new TtlCache();

    expect(await cache.get("a", 1000, async () => "A")).toBe("A");
    expect(await cache.get("b", 1000, async () => "B")).toBe("B");
    expect(cache.size).toBe(2);
  });

  it("drops a single entry", async () => {
    const cache = new TtlCache();
    const load = vi.fn().mockResolvedValue("value");

    await cache.get("k", 1000, load);
    cache.delete("k");
    await cache.get("k", 1000, load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(() => cache.delete("missing")).not.toThrow();
  });

  // Shutdown clears the cache; a timer left behind would keep the process up.
  it("clears everything and cancels the pending expiries", async () => {
    const cache = new TtlCache();

    await cache.get("a", 1000, async () => "A");
    await cache.get("b", 1000, async () => "B");

    cache.clear();

    expect(cache.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  // A load can reject long after its entry was dropped and replaced by a
  // fresh one — the rejection is on no clock this cache controls. An
  // unguarded delete then threw away perfectly good data on behalf of a
  // result nobody was waiting for any more.
  //
  // delete() is what gets the entry out of the way here. An expiry cannot:
  // the TTL timer only starts once a load resolves, so an in-flight entry is
  // never evicted out from under itself. A write dropping the key mid-build
  // is the case that remains, and it is the ordinary one — every save clears
  // the sitemap and the feeds.
  it("a late rejection does not evict the entry that replaced it", async () => {
    const cache = new TtlCache();

    let failLoad: (error: Error) => void = () => {};
    const slowFailure = new Promise<string>((_, reject) => {
      failLoad = reject;
    });

    // First load: still in flight when a write drops its entry.
    void cache.get("k", 1000, () => slowFailure).catch(() => {});
    cache.delete("k");

    // Second load succeeds and takes the key.
    expect(await cache.get("k", 1000, async () => "fresh")).toBe("fresh");

    // Now the first one finally gives up.
    failLoad(new Error("too late"));
    await vi.advanceTimersByTimeAsync(0);

    expect(cache.has("k")).toBe(true);
    expect(await cache.get("k", 1000, async () => "reloaded")).toBe("fresh");
  });

  /**
   * The TTL used to be armed the moment the key was claimed, so a load slower
   * than its own lifetime was evicted while still running: the next request
   * began a second build of the very thing already being built, and neither
   * was ever cached. A full sitemap build on a grown catalogue is exactly
   * that shape.
   */
  it("does not evict a load that outlives its own TTL", async () => {
    const cache = new TtlCache();

    let finishLoad: (value: string) => void = () => {};
    const slowLoad = new Promise<string>((resolve) => {
      finishLoad = resolve;
    });

    let loads = 0;
    const load = () => {
      loads++;
      return slowLoad;
    };

    const first = cache.get("k", 1000, load);

    // Well past the TTL, with the load still in flight.
    await vi.advanceTimersByTimeAsync(5000);

    // Still the same in-flight entry, so a second caller shares it rather
    // than starting a build of its own.
    expect(cache.has("k")).toBe(true);
    expect(cache.get("k", 1000, load)).toBe(first);
    expect(loads).toBe(1);

    finishLoad("built");

    expect(await first).toBe("built");
  });

  // The lifetime is counted from the value existing, not from it being asked
  // for, so a slow build is still served for the full TTL afterwards.
  it("counts the TTL from when the load resolved", async () => {
    const cache = new TtlCache();

    let finishLoad: (value: string) => void = () => {};
    const slowLoad = new Promise<string>((resolve) => {
      finishLoad = resolve;
    });

    void cache.get("k", 1000, () => slowLoad);

    await vi.advanceTimersByTimeAsync(5000);
    finishLoad("built");
    await vi.advanceTimersByTimeAsync(0);

    // 999ms after resolving: still held.
    await vi.advanceTimersByTimeAsync(999);
    expect(cache.has("k")).toBe(true);

    await vi.advanceTimersByTimeAsync(2);
    expect(cache.has("k")).toBe(false);
  });

  // The other half of the same guard: a rejection while the entry is still
  // the current one must drop it, or one blip would be served for the whole
  // lifetime of the entry.
  it("still drops the entry when its own load rejects", async () => {
    const cache = new TtlCache();

    await expect(
      cache.get("k", 1000, async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");

    expect(cache.has("k")).toBe(false);
  });

  /**
   * ...unless the caller asks for the failure to be remembered, which the
   * sidebar does. With Postgres away every entry rejects on every request,
   * each after waiting out the pool's connection timeout, so a page view
   * paid for the outage six times over and the next one paid again.
   */
  it("remembers a rejection for failureTtlMs when one is given", async () => {
    const cache = new TtlCache();
    const load = vi.fn().mockRejectedValue(new Error("db down"));

    await expect(cache.get("k", 1000, load, 500)).rejects.toThrow("db down");

    expect(cache.has("k")).toBe(true);

    await expect(cache.get("k", 1000, load, 500)).rejects.toThrow("db down");
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);

    expect(cache.has("k")).toBe(false);
  });

  /**
   * A lifetime that is a property of the value rather than of the key: the
   * game of the week must not be held past its own endDate, whatever the
   * nominal hour says.
   */
  it("takes the TTL from the value when handed a function", async () => {
    const cache = new TtlCache();

    await cache.get("k", (value: { ttl: number }) => value.ttl, async () => ({
      ttl: 200,
    }));

    expect(cache.has("k")).toBe(true);

    await vi.advanceTimersByTimeAsync(200);

    expect(cache.has("k")).toBe(false);
  });

  // A value already past its moment is simply not cacheable, and a negative
  // delay must not be handed to setTimeout as one.
  it("clamps a negative computed TTL to an immediate expiry", async () => {
    const cache = new TtlCache();

    await cache.get("k", () => -5_000, async () => "value");

    await vi.advanceTimersByTimeAsync(0);

    expect(cache.has("k")).toBe(false);
  });
});
