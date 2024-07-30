import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Options } from "express-rate-limit";
import {
  PostgresRateLimitStore,
  startRateLimitPruning,
  stopRateLimitPruning,
} from "../../utils/rate-limit-store.ts";
import logger from "../../utils/logger.ts";
import db from "../../db.ts";

/**
 * The counts used to live in the memory of whichever process handled the
 * request, so every limit applied once per machine rather than once for the
 * app — and the limits that matter are the ones guarding login attempts and
 * comment posting, where doubling is a weakened control, not a tuning detail.
 */
const WINDOW_MS = 60_000;

function makeStore(prefix: string): PostgresRateLimitStore {
  const store = new PostgresRateLimitStore(prefix);

  store.init({ windowMs: WINDOW_MS } as Options);

  return store;
}

/** Pushes a key's window into the past, without waiting for one to pass. */
async function expireWindow(key: string): Promise<void> {
  await db.query(
    `UPDATE "rate_limits" SET "expiresAt" = NOW() - INTERVAL '1 second'
     WHERE "key" = $1`,
    [key],
  );
}

/** How many rows the table holds under a LIKE pattern — for the sweep below. */
async function countKeys(pattern: string): Promise<number> {
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS count FROM "rate_limits" WHERE "key" LIKE $1',
    [pattern],
  );

  return rows[0].count;
}

describe("PostgresRateLimitStore", () => {
  afterEach(async () => {
    // Before the cleanup below, which needs a db.query that is not somebody's
    // spy. Only the pruning block used to restore, so a test that stubbed
    // db.query anywhere else left the stub in place for everything that ran
    // after it — the failure then landed on an unrelated test further down
    // the file, which is the hardest kind to read back to its cause.
    vi.restoreAllMocks();

    await db.query('DELETE FROM "rate_limits" WHERE "key" LIKE $1', ["test-%"]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM "rate_limits" WHERE "key" LIKE $1', ["test-%"]);
  });

  // Declared false so express-rate-limit knows the counts are shared, which
  // is also what its double-count check reads.
  it("reports its keys as shared", () => {
    expect(makeStore("test-a").localKeys).toBe(false);
  });

  it("counts hits up and reports the window's end", async () => {
    const store = makeStore("test-count");

    const first = await store.increment("1.2.3.4");
    const second = await store.increment("1.2.3.4");
    const third = await store.increment("1.2.3.4");

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(third.totalHits).toBe(3);

    expect(first.resetTime).toBeInstanceOf(Date);
    expect(first.resetTime!.getTime()).toBeGreaterThan(Date.now());
    // The window is set once and not extended by later hits, or a steady
    // trickle of requests would keep pushing the reset out of reach.
    expect(third.resetTime!.getTime()).toBe(first.resetTime!.getTime());
  });

  it("counts each address separately", async () => {
    const store = makeStore("test-addr");

    await store.increment("1.1.1.1");
    await store.increment("1.1.1.1");

    expect((await store.increment("2.2.2.2")).totalHits).toBe(1);
  });

  // The whole reason each limiter gets its own instance: they share one table.
  it("keeps two limiters' counters apart", async () => {
    const login = makeStore("test-login");
    const comment = makeStore("test-comment");

    await login.increment("1.2.3.4");
    await login.increment("1.2.3.4");

    expect((await comment.increment("1.2.3.4")).totalHits).toBe(1);
    expect((await login.increment("1.2.3.4")).totalHits).toBe(3);
  });

  // Reading the row and then writing it would let two concurrent requests
  // both see the same total — the one race a rate limiter cannot afford.
  it("counts concurrent hits without losing any", async () => {
    const store = makeStore("test-race");

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.increment("1.2.3.4")),
    );

    expect(results.map((result) => result.totalHits).sort((a, b) => a - b)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
  });

  it("starts a fresh window once the old one has run out", async () => {
    const store = makeStore("test-window");

    await store.increment("1.2.3.4");
    await store.increment("1.2.3.4");
    await expireWindow("test-window:1.2.3.4");

    const afterExpiry = await store.increment("1.2.3.4");

    expect(afterExpiry.totalHits).toBe(1);
    expect(afterExpiry.resetTime!.getTime()).toBeGreaterThan(Date.now());
  });

  describe("get", () => {
    it("reports the running total", async () => {
      const store = makeStore("test-get");

      await store.increment("1.2.3.4");
      await store.increment("1.2.3.4");

      expect((await store.get("1.2.3.4"))?.totalHits).toBe(2);
    });

    it("knows nothing about an address that has not been seen", async () => {
      expect(await makeStore("test-get2").get("9.9.9.9")).toBeUndefined();
    });

    it("treats an expired window as nothing", async () => {
      const store = makeStore("test-get3");

      await store.increment("1.2.3.4");
      await expireWindow("test-get3:1.2.3.4");

      expect(await store.get("1.2.3.4")).toBeUndefined();
    });
  });

  describe("decrement", () => {
    it("gives a hit back", async () => {
      const store = makeStore("test-dec");

      await store.increment("1.2.3.4");
      await store.increment("1.2.3.4");
      await store.decrement("1.2.3.4");

      expect((await store.get("1.2.3.4"))?.totalHits).toBe(1);
    });

    it("does not go below zero", async () => {
      const store = makeStore("test-dec2");

      await store.increment("1.2.3.4");
      await store.decrement("1.2.3.4");
      await store.decrement("1.2.3.4");

      expect((await store.get("1.2.3.4"))?.totalHits).toBe(0);
    });

    it("does nothing for an address that has not been seen", async () => {
      await expect(
        makeStore("test-dec3").decrement("9.9.9.9"),
      ).resolves.toBeUndefined();
    });

    /**
     * The one method here that must not reject, and not for tidiness.
     *
     * express-rate-limit awaits every other store call inside the middleware,
     * where `passOnStoreError` turns a failure into "let the request
     * through". The decrement is attached to the response's "finish" event
     * and left unguarded — `void finishPromise.then(async () => { ... await
     * decrementKey() })`, with no catch in the chain — so a rejection is an
     * unhandled one, and node terminates the process on those.
     *
     * That would mean a database blip during a *successful* login taking the
     * whole site down, which is the failure this app is built not to have.
     */
    it("swallows a database failure rather than rejecting", async () => {
      const failure = new Error("connection terminated unexpectedly");

      vi.spyOn(db, "query").mockRejectedValueOnce(failure as never);
      const logged = vi.spyOn(logger, "error").mockImplementation(() => {});

      await expect(
        makeStore("test-dec4").decrement("1.2.3.4"),
      ).resolves.toBeUndefined();

      // Swallowed, not hidden: the line is what says the refund was lost.
      expect(logged).toHaveBeenCalledWith(
        "Rate limit decrement failed:",
        failure,
      );
    });
  });

  describe("resetKey", () => {
    it("clears one address and leaves the rest", async () => {
      const store = makeStore("test-reset");

      await store.increment("1.1.1.1");
      await store.increment("2.2.2.2");
      await store.resetKey("1.1.1.1");

      expect(await store.get("1.1.1.1")).toBeUndefined();
      expect((await store.get("2.2.2.2"))?.totalHits).toBe(1);
    });
  });

  describe("resetAll", () => {
    it("clears this limiter's keys without touching another's", async () => {
      const login = makeStore("test-all-login");
      const comment = makeStore("test-all-comment");

      await login.increment("1.1.1.1");
      await login.increment("2.2.2.2");
      await comment.increment("1.1.1.1");

      await login.resetAll();

      expect(await login.get("1.1.1.1")).toBeUndefined();
      expect(await login.get("2.2.2.2")).toBeUndefined();
      expect((await comment.get("1.1.1.1"))?.totalHits).toBe(1);
    });
  });

  /**
   * Housekeeping, and the whole of the module that had no test at all.
   *
   * Nothing reads an expired row — increment() resets one in place — so this
   * is purely about "rate_limits" not growing without bound. The properties
   * worth pinning down are the two that make it safe to leave running: it
   * must be one timer for the process however many limiters exist, and a
   * failed sweep must not take the process down with it.
   */
  describe("pruning", () => {
    /** PRUNE_INTERVAL_MS in the module under test. */
    const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

    afterEach(() => {
      // Before the timers go back to real, or the interval outlives the test
      // as a real one.
      stopRateLimitPruning();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("sweeps expired windows on the interval", async () => {
      const store = makeStore("test-prune");

      await store.increment("1.2.3.4");
      await store.increment("5.6.7.8");
      await expireWindow("test-prune:1.2.3.4");

      /**
       * The sweep is started by the timer as `void prune()` — deliberately
       * fire-and-forget, so a slow delete cannot hold the interval up.
       * Advancing the clock therefore *starts* the delete and does not wait
       * for it: advanceTimersByTimeAsync drains the microtask queue, and a
       * real round trip to Postgres is not on it.
       *
       * So the promise itself has to be captured. Asserting straight after
       * the tick is a race that passes on an idle machine and fails on a busy
       * one, which is the sort of test that gets rerun rather than read.
       */
      let sweep: Promise<unknown> | undefined;
      const realQuery = db.query.bind(db);

      const spy = vi
        .spyOn(db, "query")
        .mockImplementation(((...args: unknown[]) => {
          const result = (realQuery as (...a: unknown[]) => Promise<unknown>)(
            ...args,
          );

          sweep = result;

          return result;
        }) as never);

      // Nothing runs on the way in: the sweep is on the interval only.
      vi.useFakeTimers();
      startRateLimitPruning();

      expect(sweep, "the sweep ran before its first interval").toBeUndefined();

      await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);
      await sweep;

      // Back to the real query, so the assertions below are not recorded by
      // the spy — and so a failure here is not confused with the sweep.
      spy.mockRestore();

      // The expired one goes; the live one stays.
      expect(await countKeys("test-prune:%")).toBe(1);
      expect((await store.get("5.6.7.8"))?.totalHits).toBe(1);
    });

    // One timer for the whole process, not one per store: every instance
    // writes to the same table, so five limiters would otherwise run five
    // identical deletes against it.
    it("starts one timer however many times it is asked", async () => {
      const query = vi.spyOn(db, "query");

      vi.useFakeTimers();
      startRateLimitPruning();
      startRateLimitPruning();
      startRateLimitPruning();

      await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);

      expect(query).toHaveBeenCalledTimes(1);
    });

    it("stops sweeping once told to", async () => {
      const query = vi.spyOn(db, "query");

      vi.useFakeTimers();
      startRateLimitPruning();
      stopRateLimitPruning();

      await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS * 3);

      expect(query).not.toHaveBeenCalled();
    });

    it("can be started again after being stopped", async () => {
      const query = vi.spyOn(db, "query");

      vi.useFakeTimers();
      startRateLimitPruning();
      stopRateLimitPruning();
      startRateLimitPruning();

      await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);

      expect(query).toHaveBeenCalledTimes(1);
    });

    // Stopping something that was never started is what the shutdown path in
    // index.ts does when the process never got as far as starting it.
    it("does not mind being stopped twice", () => {
      expect(() => {
        stopRateLimitPruning();
        stopRateLimitPruning();
      }).not.toThrow();
    });

    /**
     * The reason the sweep is allowed to run unattended: it is inside a
     * `void prune()` on a timer, so a rejection nothing caught would be an
     * unhandled one — and in Node that is a process exit by default. A
     * database blip must cost the site a swept table, not its availability.
     */
    it("logs a failed sweep rather than letting it escape", async () => {
      const failure = new Error("database is down");

      vi.spyOn(db, "query").mockRejectedValue(failure);
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});

      vi.useFakeTimers();
      startRateLimitPruning();

      await expect(
        vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS),
      ).resolves.not.toThrow();

      expect(error).toHaveBeenCalledWith(
        "Rate limit pruning failed:",
        failure,
      );
    });

    it("keeps sweeping after a failure", async () => {
      const query = vi
        .spyOn(db, "query")
        .mockRejectedValueOnce(new Error("blip"))
        .mockResolvedValue({ rows: [] } as never);

      vi.spyOn(logger, "error").mockImplementation(() => {});

      vi.useFakeTimers();
      startRateLimitPruning();

      await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS * 2);

      expect(query).toHaveBeenCalledTimes(2);
    });
  });
});
