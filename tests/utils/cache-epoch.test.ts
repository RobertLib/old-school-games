import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db from "../../db.ts";
import logger from "../../utils/logger.ts";
import { TtlCache } from "../../utils/cache.ts";
import {
  LATEST_COMMENTS_KEY,
  sidebarCache,
} from "../../utils/sidebar-cache.ts";
import {
  BUMP_RETRY_DELAYS_MS,
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
 *
 * Every case runs on the fake clock. Most of what is under test is time —
 * an interval, a backoff, a budget, a retry schedule — and the module reads
 * the clock twice per attempt, when it starts and when it fails, so a case
 * has to be able to move both the clock and the timers that a slow query
 * waits on. That is also what the old backoff tests could not express: their
 * failures all arrived in the same instant they were asked for.
 */
describe("cache epoch", () => {
  let cache: TtlCache;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: 0 });
    resetCacheEpochForTests();
    cache = new TtlCache();
    sidebarCache.clear();
  });

  afterEach(() => {
    // Before the timers go back to real ones: a retry still waiting would
    // otherwise be a fake timer nobody ever advances past.
    resetCacheEpochForTests();
    cache.clear();
    sidebarCache.clear();
    mockDb.query.mockReset();
    delete (mockDb as { ending?: boolean }).ending;
    vi.useRealTimers();
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

  /** A check at `ms` on the clock the module reads. */
  function syncAt(ms: number): Promise<void> {
    vi.setSystemTime(ms);
    return syncCacheEpoch();
  }

  /**
   * A query that fails the way an outage makes it fail: after the pool has
   * waited its two seconds for a connection it cannot hand out (db.ts).
   */
  function failsAfter(ms: number) {
    return () =>
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("timeout exceeded when trying to connect")),
          ms,
        ),
      ) as any;
  }

  /** A request through the middleware, and whether it has been let through. */
  function request() {
    const next = vi.fn();
    const done = cacheEpochSync({} as any, {} as any, next);

    return { next, done };
  }

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

    await syncAt(1_000);

    expect(cache.has("k")).toBe(true);
  });

  it("drops every cache when the counter has moved", async () => {
    await warm();
    mockDb.query.mockResolvedValueOnce(epochs({ all: 5 }));
    await syncAt(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ all: 6 }));
    await syncAt(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(cache.has("k")).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("moved for all"),
    );
  });

  it("keeps the caches when the counter has not moved", async () => {
    await warm();
    mockDb.query.mockResolvedValue(epochs({ all: 5 }));
    await syncAt(1_000);
    await syncAt(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(cache.has("k")).toBe(true);
  });

  it("reads the counter at most once per interval", async () => {
    mockDb.query.mockResolvedValue(epochs({ all: 1 }));

    await syncAt(1_000);
    await syncAt(1_000 + EPOCH_CHECK_INTERVAL_MS - 1);
    await syncAt(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it("shares one query between concurrent callers", async () => {
    mockDb.query.mockResolvedValue(epochs({ all: 1 }));

    await Promise.all([syncAt(1_000), syncAt(1_000)]);

    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("logs and carries on when the counter cannot be read", async () => {
    await warm();
    mockDb.query.mockRejectedValueOnce(new Error("down"));

    await expect(syncAt(1_000)).resolves.toBeUndefined();

    expect(cache.has("k")).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      "Could not read the cache epoch:",
      expect.any(Error),
    );
  });

  it("copes with a database that has no counter row yet", async () => {
    await warm();
    mockDb.query.mockResolvedValueOnce(epochs({}));

    await syncAt(1_000);

    expect(cache.has("k")).toBe(true);
  });

  // The process that made the write has just rebuilt its own caches; it must
  // not throw them away again when it next sees the number it moved.
  it("adopts the value it bumped to, so it does not clear itself", async () => {
    await warm();
    mockDb.query.mockResolvedValueOnce(epochs({ all: 5 }));
    await syncAt(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ all: 6 }));
    await bumpCacheEpoch();

    expect(mockDb.query).toHaveBeenLastCalledWith(
      expect.stringContaining('INSERT INTO "cache_epochs"'),
      ["all"],
    );

    mockDb.query.mockResolvedValueOnce(epochs({ all: 6 }));
    await syncAt(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(cache.has("k")).toBe(true);
  });

  /**
   * The number a bump returns counts every other machine's bumps too, and
   * adopting it used to be read as "nothing to catch up on": machine C
   * deletes a game (5 → 6), machine A posts news before its next sync and
   * gets 7 back, adopts it, and never drops the caches C's write was about —
   * the deleted game stayed in A's sidebars for the rest of their TTL.
   */
  it("applies a move elsewhere that its own bump skipped over", async () => {
    await warm();
    mockDb.query.mockResolvedValueOnce(epochs({ all: 5 }));
    await syncAt(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ all: 7 }));
    await bumpCacheEpoch();

    expect(cache.has("k")).toBe(false);
  });

  it("applies only the skipped scope's effect", async () => {
    await warm();
    await warmCommentsWidget();
    mockDb.query.mockResolvedValueOnce(epochs({ all: 5, comments: 5 }));
    await syncAt(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ comments: 7 }));
    await bumpCacheEpoch("comments");

    expect(sidebarCache.has(LATEST_COMMENTS_KEY)).toBe(false);
    // Nothing moved in the broad scope, so nothing else goes.
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
    await syncAt(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ all: 1 }));
    await syncAt(1_000 + FAILURE_BACKOFF_MS);

    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it("still shares one attempt while the backoff holds", async () => {
    mockDb.query.mockRejectedValueOnce(new Error("down"));
    await syncAt(1_000);

    await syncAt(1_000 + FAILURE_BACKOFF_MS - 1);

    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  /**
   * The backoff was counted from when the attempt *started*, and the failure
   * an outage produces is a slow one — the pool's two seconds. By the time it
   * arrived the backoff had already run out, so the very next request began
   * another doomed attempt: against a black-holed database, one was always
   * in flight.
   */
  it("counts the backoff from when a slow failure arrives", async () => {
    mockDb.query.mockImplementation(failsAfter(2_000));

    const first = syncAt(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await first;

    expect(mockDb.query).toHaveBeenCalledTimes(1);

    // The failure has only just arrived: the backoff starts now.
    void syncCacheEpoch();
    vi.advanceTimersByTime(FAILURE_BACKOFF_MS - 1);
    void syncCacheEpoch();

    expect(mockDb.query).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    void syncCacheEpoch();

    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  /**
   * With Postgres unreachable the query does not fail quickly — it waits for
   * a connection the pool cannot produce — and this middleware sits above
   * every page. The one request per interval that ran the check was the one
   * request per interval that hung.
   */
  it("serves the page rather than waiting out an unreachable database", async () => {
    mockDb.query.mockImplementation(() => new Promise(() => {}) as any);

    const { next, done } = request();

    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUT_MS);
    await done;

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("is an express middleware that always continues", async () => {
    mockDb.query.mockRejectedValueOnce(new Error("down"));

    const { next, done } = request();
    await done;

    expect(next).toHaveBeenCalledTimes(1);
  });

  /**
   * The race bounded how long one request waited, not how many waited. Every
   * request that arrives while a check is out shares it, and during an outage
   * there was always one out — so nearly every page on the site waited for a
   * check that was going to fail: 76 of 80 held, measured against a
   * black-holed database. Once a check has failed, nobody waits for the next.
   */
  it("does not hold a request behind a check while the last one failed", async () => {
    mockDb.query.mockImplementation(failsAfter(2_000));

    // The first request into an outage still waits, and only for its budget.
    const first = request();
    await vi.advanceTimersByTimeAsync(2_000);
    await first.done;
    expect(first.next).toHaveBeenCalledTimes(1);

    // Past the backoff, the next check starts — and the page does not wait.
    vi.advanceTimersByTime(FAILURE_BACKOFF_MS);
    const second = request();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockDb.query).toHaveBeenCalledTimes(2);
    expect(second.next).toHaveBeenCalledTimes(1);

    await second.done;
  });

  // A check that is simply not answering holds requests just the same, and
  // for as long as it stays out; after one request's budget it counts as
  // failing too.
  it("does not hold a request behind a check that has outlived a request's budget", async () => {
    mockDb.query.mockImplementation(() => new Promise(() => {}) as any);

    const first = request();
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUT_MS);
    await first.done;

    const second = request();
    await vi.advanceTimersByTimeAsync(0);

    expect(second.next).toHaveBeenCalledTimes(1);
    // Joined, not duplicated: the check that is out is still the only one.
    expect(mockDb.query).toHaveBeenCalledTimes(1);

    await second.done;
  });

  // ...and back to waiting once a check has worked, because that wait is what
  // serves the request on a check boundary from fresh caches.
  it("waits for the check again once one has succeeded", async () => {
    mockDb.query.mockRejectedValueOnce(new Error("down"));
    await syncAt(0);

    // In the background, and it works.
    mockDb.query.mockResolvedValueOnce(epochs({ all: 1 }));
    vi.setSystemTime(FAILURE_BACKOFF_MS);
    const background = request();
    await background.done;
    await vi.advanceTimersByTimeAsync(0);

    expect(mockDb.query).toHaveBeenCalledTimes(2);

    // A slow success at the next boundary is waited for.
    mockDb.query.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(epochs({ all: 1 })), 500),
        ) as any,
    );
    vi.setSystemTime(FAILURE_BACKOFF_MS + EPOCH_CHECK_INTERVAL_MS);

    const held = request();
    await vi.advanceTimersByTimeAsync(499);
    expect(held.next).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await held.done;
    expect(held.next).toHaveBeenCalledTimes(1);
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
    await syncAt(1_000);

    // ...and the next check, which sees the number the bump wrote.
    mockDb.query.mockResolvedValueOnce(epochs({ all: 6 }));
    await syncAt(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(cache.has("k")).toBe(true);
    expect(logger.info).not.toHaveBeenCalled();
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
    await syncAt(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ all: 5, comments: 6 }));
    await syncAt(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(sidebarCache.has(LATEST_COMMENTS_KEY)).toBe(false);
    expect(cache.has("k")).toBe(true);
  });

  // ...and the broad scope still means everything, which is what a game or
  // news write legitimately invalidates.
  it("drops every cache when the broad scope moves", async () => {
    await warm();
    await warmCommentsWidget();

    mockDb.query.mockResolvedValueOnce(epochs({ all: 5, comments: 5 }));
    await syncAt(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ all: 6, comments: 5 }));
    await syncAt(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(cache.has("k")).toBe(false);
    expect(sidebarCache.has(LATEST_COMMENTS_KEY)).toBe(false);
  });

  it("bumps the scope it is given", async () => {
    mockDb.query.mockResolvedValueOnce(epochs({ comments: 2 }));

    await bumpCacheEpoch("comments");

    expect(mockDb.query).toHaveBeenLastCalledWith(
      expect.stringContaining("ON CONFLICT"),
      ["comments"],
    );
  });

  /**
   * The bump used to be a plain UPDATE, and "cache_epochs" is seeded by
   * migration: a scope whose row was missing matched nothing, returned
   * nothing and invalidated nothing on any other machine — for the life of
   * the deploy, with no line anywhere saying so.
   */
  it("inserts the row when a scope has none, rather than bumping nothing", async () => {
    (mockDb.query as any).mockResolvedValueOnce({ rows: [{ epoch: "1" }] });

    await bumpCacheEpoch("comments");

    const [sql] = mockDb.query.mock.lastCall!;

    expect(sql).toContain('INSERT INTO "cache_epochs"');
    expect(sql).toContain('ON CONFLICT ("scope") DO UPDATE');
    // Qualified, because an unqualified "epoch" inside DO UPDATE is the
    // *proposed* row's — the column default — so the counter would reset
    // rather than advance, and a counter going backwards is what `adopt`
    // exists to make impossible.
    expect(sql).toContain('"cache_epochs"."epoch" + 1');
  });

  // Unreachable — an upsert always has a row to return — but the failure it
  // would stand for is the one this module exists to prevent, and the shape
  // this replaced failed in exactly that way without a word.
  it("says so if a bump somehow returns no row", async () => {
    (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

    await bumpCacheEpoch("comments");

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("returned no row"),
    );
  });

  // A narrow bump must not silence the broad scope: the two counters are
  // independent, and a comment posted here says nothing about a game written
  // elsewhere.
  it("still applies a broad move after a local comment bump", async () => {
    await warm();

    mockDb.query.mockResolvedValueOnce(epochs({ all: 5, comments: 5 }));
    await syncAt(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ comments: 6 }));
    await bumpCacheEpoch("comments");

    mockDb.query.mockResolvedValueOnce(epochs({ all: 6, comments: 6 }));
    await syncAt(1_000 + EPOCH_CHECK_INTERVAL_MS);

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
    await syncAt(1_000);

    mockDb.query.mockResolvedValueOnce(epochs({ all: 5, futurething: 9 }));
    await syncAt(1_000 + EPOCH_CHECK_INTERVAL_MS);

    expect(cache.has("k")).toBe(true);
    expect(logger.info).not.toHaveBeenCalled();
  });

  /**
   * The models `void` the bump after a write that has committed, and a
   * failure used to be logged and dropped: every other machine went on
   * serving what the write had deleted for as long as its caches lasted — a
   * deleted game in the sitemap for up to a day.
   */
  describe("a failed bump", () => {
    const bumps = () =>
      mockDb.query.mock.calls.filter(([sql]) =>
        String(sql).includes('INSERT INTO "cache_epochs"'),
      );

    it("is tried again a second later, and the number it lands on adopted", async () => {
      await warm();
      mockDb.query.mockResolvedValueOnce(epochs({ all: 5 }));
      await syncAt(1_000);

      mockDb.query
        .mockRejectedValueOnce(new Error("down"))
        .mockResolvedValueOnce(epochs({ all: 6 }));
      await bumpCacheEpoch();

      expect(bumps()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(BUMP_RETRY_DELAYS_MS[0] - 1);
      expect(bumps()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(bumps()).toHaveLength(2);
      expect(bumps()[1][1]).toEqual(["all"]);
      expect(logger.info).toHaveBeenCalledWith(
        'Bumped the "all" cache epoch on retry 1.',
      );

      // Adopted like any bump: the next check sees the number this process
      // moved it to, and does not clear what it rebuilt.
      mockDb.query.mockResolvedValueOnce(epochs({ all: 6 }));
      await syncAt(1_000 + EPOCH_CHECK_INTERVAL_MS);

      expect(cache.has("k")).toBe(true);
    });

    // Any one bump after the writes is enough — other machines compare the
    // number, they do not count its steps — so a burst of failures is one
    // retry, not one each.
    it("is one retry per scope however many failed", async () => {
      mockDb.query.mockRejectedValue(new Error("down"));
      await bumpCacheEpoch();
      await bumpCacheEpoch();
      await bumpCacheEpoch();

      mockDb.query.mockResolvedValue(epochs({ all: 6 }));
      await vi.advanceTimersByTimeAsync(BUMP_RETRY_DELAYS_MS[0]);

      expect(bumps()).toHaveLength(4);

      // And nothing more once it has landed.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(bumps()).toHaveLength(4);
    });

    it("keeps the scopes apart", async () => {
      mockDb.query.mockRejectedValue(new Error("down"));
      await bumpCacheEpoch("all");
      await bumpCacheEpoch("comments");

      mockDb.query.mockResolvedValue(epochs({ all: 6 }));
      await vi.advanceTimersByTimeAsync(BUMP_RETRY_DELAYS_MS[0]);

      expect(bumps().slice(2).map(([, values]) => values)).toEqual([
        ["all"],
        ["comments"],
      ]);
    });

    // Bounded: past a minute or so this is an outage no retry helps with, and
    // the TTLs are the bound again. Said, because what it loses is real.
    it("gives up after a bounded schedule, and says so", async () => {
      mockDb.query.mockRejectedValue(new Error("down"));
      await bumpCacheEpoch("comments");

      const schedule = BUMP_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
      await vi.advanceTimersByTimeAsync(schedule);

      expect(bumps()).toHaveLength(1 + BUMP_RETRY_DELAYS_MS.length);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          `Gave up bumping the "comments" cache epoch after ${1 + BUMP_RETRY_DELAYS_MS.length} attempts`,
        ),
      );

      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(bumps()).toHaveLength(1 + BUMP_RETRY_DELAYS_MS.length);
    });

    /**
     * A TypeError is this code failing, the same way every time, and six
     * retries would be six more copies of one line. It is also what a suite
     * that mocks the pool gets when no answer is queued for the bump — and a
     * retry would fire a second later into another test, taking the answer
     * queued for that one.
     */
    it("is not retried when what failed was the code rather than the database", async () => {
      // No row set at all: destructuring it is the TypeError.
      mockDb.query.mockResolvedValueOnce(undefined as any);
      await bumpCacheEpoch();

      expect(logger.error).toHaveBeenCalledWith(
        "Could not bump the cache epoch:",
        expect.any(TypeError),
      );

      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(bumps()).toHaveLength(1);
    });

    // A waiting retry must never be what keeps a process alive — least of
    // all one that is draining.
    it("waits on a timer that does not hold the process open", async () => {
      const scheduled = vi.spyOn(globalThis, "setTimeout");

      try {
        mockDb.query.mockRejectedValueOnce(new Error("down"));
        await bumpCacheEpoch();

        const timer = scheduled.mock.results.at(-1)?.value as NodeJS.Timeout;

        expect(timer.hasRef()).toBe(false);
      } finally {
        scheduled.mockRestore();
      }
    });

    /**
     * A retry coming due after pool.end() would fail with "Cannot use a pool
     * after calling end on the pool" and be logged as one more error on the
     * way out of a clean deploy. It is given up instead, and said to be.
     */
    it("does not run against a pool that is ending", async () => {
      mockDb.query.mockRejectedValueOnce(new Error("down"));
      await bumpCacheEpoch();

      (mockDb as { ending?: boolean }).ending = true;
      await vi.advanceTimersByTimeAsync(BUMP_RETRY_DELAYS_MS[0]);

      expect(bumps()).toHaveLength(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Shutting down with the "all" cache epoch still unbumped'),
      );

      // Given up, not postponed.
      delete (mockDb as { ending?: boolean }).ending;
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(bumps()).toHaveLength(1);
    });

    /**
     * A retry already in flight cannot cover a write that failed its bump
     * after that retry's UPDATE went out: the UPDATE may commit before the
     * write did, and a machine syncing in between rebuilds from the old data
     * and then sees no further move. That write gets a round of its own.
     */
    it("goes round again for a bump that failed while the retry was out", async () => {
      mockDb.query.mockRejectedValueOnce(new Error("down"));
      await bumpCacheEpoch();

      let land: () => void = () => {};
      mockDb.query.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            land = () => resolve(epochs({ all: 6 }));
          }) as any,
      );
      await vi.advanceTimersByTimeAsync(BUMP_RETRY_DELAYS_MS[0]);
      expect(bumps()).toHaveLength(2);

      // Another write's bump fails while that retry is out...
      mockDb.query.mockRejectedValueOnce(new Error("down"));
      await bumpCacheEpoch();
      expect(bumps()).toHaveLength(3);

      // ...so the retry landing is not the end of it.
      land();
      mockDb.query.mockResolvedValueOnce(epochs({ all: 7 }));
      await vi.advanceTimersByTimeAsync(BUMP_RETRY_DELAYS_MS[0]);

      expect(bumps()).toHaveLength(4);
    });
  });
});
