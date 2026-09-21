import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SHUTDOWN_TIMEOUT_MS,
  createShutdown,
  type ShutdownTimer,
} from "../../utils/shutdown.ts";

/**
 * The drain, driven against fakes.
 *
 * Every case here is a bug that reached production, because until this module
 * was pulled out of index.ts there was nowhere to write them down: index.ts
 * listens on a port when it is imported, which is why it is the one file
 * excluded from the coverage list. Against the real server, pool and
 * process.exit none of these can be provoked without taking the test runner
 * down with them — a second SIGTERM, a drain that lands after the fallback
 * fired, a pool that never calls back.
 */

/** A server whose close() is completed by the test, whenever it chooses. */
function fakeServer() {
  let release: (() => void) | undefined;

  return {
    closeIdleConnections: vi.fn(),
    close: vi.fn((callback?: () => void) => {
      release = callback;
    }),
    /** Finishes the drain, as the real server does once nothing is in flight. */
    drained: () => release?.(),
    get closed() {
      return release !== undefined;
    },
  };
}

/** A pool whose end() callback is likewise the test's to fire. */
function fakePool() {
  let release: (() => void) | undefined;

  return {
    end: vi.fn((callback: () => void) => {
      release = callback;
    }),
    /** Reports every client released, as the real pool does. */
    ended: () => release?.(),
    get ending() {
      return release !== undefined;
    },
  };
}

function fakeTimers() {
  const scheduled: { handler: () => void; ms: number; timer: ShutdownTimer }[] =
    [];
  const unref = vi.fn();
  const clearTimeout = vi.fn();

  return {
    scheduled,
    unref,
    clearTimeout,
    timers: {
      setTimeout: vi.fn((handler: () => void, ms: number) => {
        const timer = { unref };

        scheduled.push({ handler, ms, timer });

        return timer;
      }),
      clearTimeout,
    },
  };
}

function harness() {
  const server = fakeServer();
  const pool = fakePool();
  const logger = { info: vi.fn(), error: vi.fn() };
  const exit = vi.fn();
  const stopTimers = vi.fn();
  const clearCaches = vi.fn();
  const clock = fakeTimers();

  const handlers = createShutdown({
    server,
    pool,
    logger,
    stopTimers,
    clearCaches,
    timers: clock.timers,
    exit,
  });

  return { ...handlers, server, pool, logger, exit, stopTimers, clearCaches, clock };
}

describe("createShutdown", () => {
  // The "its defaults" block below spies on the global timers and on
  // process.exit. Leaving either in place would outlive the case that set it.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("on a signal", () => {
    it("stops the timers, closes idle sockets and drains the listener", () => {
      const h = harness();

      h.shutdown("SIGTERM");

      expect(h.stopTimers).toHaveBeenCalledTimes(1);
      // server.close() waits for open connections but does not close the idle
      // ones, so a browser holding a keep-alive socket kept the process up
      // until that socket's own timeout — every deploy paid for it.
      expect(h.server.closeIdleConnections).toHaveBeenCalledTimes(1);
      expect(h.server.close).toHaveBeenCalledTimes(1);
      // Nothing has left yet: the pool goes once the drain reports done.
      expect(h.pool.ending).toBe(false);
      expect(h.exit).not.toHaveBeenCalled();
    });

    it("ends the pool and exits 0 once the drain finishes", () => {
      const h = harness();

      h.shutdown("SIGTERM");
      h.server.drained();

      expect(h.clearCaches).toHaveBeenCalledTimes(1);
      expect(h.pool.ending).toBe(true);
      // Not before the pool has actually closed — the callback is what says
      // every checked-out client was released.
      expect(h.exit).not.toHaveBeenCalled();

      h.pool.ended();

      expect(h.exit).toHaveBeenCalledWith(0);
    });

    // The suite mounts the app without a listener in front of it, and
    // closeIdleConnections only arrived in Node 18.2.
    it("copes with a server that has no closeIdleConnections", () => {
      const server = fakeServer();
      const { shutdown } = createShutdown({
        server: { close: server.close },
        pool: fakePool(),
        logger: { info: vi.fn(), error: vi.fn() },
        timers: fakeTimers().timers,
        exit: vi.fn(),
      });

      expect(() => shutdown("SIGTERM")).not.toThrow();
      expect(server.close).toHaveBeenCalledTimes(1);
    });

    // stopTimers and clearCaches are what index.ts happens to pass; nothing
    // in the module needs them.
    it("works with neither stopTimers nor clearCaches", () => {
      const server = fakeServer();
      const pool = fakePool();
      const exit = vi.fn();
      const { shutdown } = createShutdown({
        server,
        pool,
        logger: { info: vi.fn(), error: vi.fn() },
        timers: fakeTimers().timers,
        exit,
      });

      shutdown("SIGTERM");
      server.drained();
      pool.ended();

      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  /**
   * A second signal is ordinary — a deploy that sends SIGTERM twice, or an
   * impatient Ctrl+C. The second pass used to call server.close() and
   * pool.end() again: both hand their callback an error, both callbacks
   * ignore it, and the inner one exits 0 — so the repeat signal cut the first
   * drain short and reported success.
   */
  describe("on a second signal", () => {
    it("does not re-run the drain", () => {
      const h = harness();

      h.shutdown("SIGTERM");
      h.shutdown("SIGTERM");

      expect(h.server.close).toHaveBeenCalledTimes(1);
      expect(h.server.closeIdleConnections).toHaveBeenCalledTimes(1);
      expect(h.stopTimers).toHaveBeenCalledTimes(1);
      expect(h.clock.timers.setTimeout).toHaveBeenCalledTimes(1);
      expect(h.logger.info).toHaveBeenCalledWith(
        "SIGTERM received again, already shutting down.",
      );
    });

    // The exit code belongs to the drain that is actually running: a SIGTERM
    // arriving during a crash's drain must not turn a failure into a success.
    it("cannot lower the exit code of a drain already under way", () => {
      const h = harness();

      h.crash("Uncaught exception", new Error("boom"));
      h.shutdown("SIGTERM");
      h.server.drained();
      h.pool.ended();

      expect(h.exit).toHaveBeenCalledWith(1);
    });
  });

  /**
   * A crash is not a clean stop, and a supervisor reading the exit status is
   * the only thing that can tell the difference.
   */
  describe("on a crash", () => {
    it("logs the stack and exits 1", () => {
      const h = harness();
      const error = new Error("boom");

      h.crash("Uncaught exception", error);

      expect(h.logger.error).toHaveBeenCalledWith(
        "Uncaught exception:",
        error.stack,
      );

      h.server.drained();
      h.pool.ended();

      expect(h.exit).toHaveBeenCalledWith(1);
    });

    it("falls back to the message when an Error carries no stack", () => {
      const h = harness();
      const error = new Error("no stack here");
      error.stack = undefined;

      h.crash("Uncaught exception", error);

      expect(h.logger.error).toHaveBeenCalledWith(
        "Uncaught exception:",
        "no stack here",
      );
    });

    // An unhandled rejection is handed whatever was rejected with, which is
    // very often not an Error at all.
    it("logs a rejection reason that is not an Error as it is", () => {
      const h = harness();

      h.crash("Unhandled promise rejection", "just a string");

      expect(h.logger.error).toHaveBeenCalledWith(
        "Unhandled promise rejection:",
        "just a string",
      );
    });
  });

  /**
   * The four arguments index.ts does *not* pass, exercised because they are
   * what actually runs in production: everything above this point drives
   * fakes, and a default that was wired up wrongly would be invisible to all
   * of it.
   */
  describe("its defaults", () => {
    /** A server and pool that report done the moment they are asked. */
    function immediate() {
      return {
        server: { close: (callback?: () => void) => callback?.() },
        pool: { end: (callback: () => void) => callback() },
      };
    }

    it("uses the real timers when none are given", () => {
      const { server, pool } = immediate();
      const exit = vi.fn();
      const setSpy = vi.spyOn(globalThis, "setTimeout");
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");

      createShutdown({
        server,
        pool,
        logger: { info: vi.fn(), error: vi.fn() },
        exit,
      }).shutdown("SIGTERM");

      // Scheduled and then cancelled, because this drain finished at once —
      // which is also the only safe way to touch the real timer here.
      expect(setSpy).toHaveBeenCalled();
      expect(clearSpy).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    });

    it("leaves through process.exit when no way out is given", () => {
      const { server, pool } = immediate();
      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);

      createShutdown({
        server,
        pool,
        logger: { info: vi.fn(), error: vi.fn() },
      }).shutdown("SIGTERM");

      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  describe("the force-exit fallback", () => {
    it("is scheduled for the shutdown timeout and unref'd", () => {
      const h = harness();

      h.shutdown("SIGTERM");

      expect(h.clock.scheduled[0]!.ms).toBe(SHUTDOWN_TIMEOUT_MS);
      // unref'd so the timer cannot by itself be the reason the process is
      // still alive: if the drain finishes first there is nothing left to
      // wait for.
      expect(h.clock.unref).toHaveBeenCalledTimes(1);
    });

    it("honours a timeout of its own when one is given", () => {
      const server = fakeServer();
      const clock = fakeTimers();

      createShutdown({
        server,
        pool: fakePool(),
        logger: { info: vi.fn(), error: vi.fn() },
        timers: clock.timers,
        exit: vi.fn(),
        timeoutMs: 250,
      }).shutdown("SIGTERM");

      expect(clock.scheduled[0]!.ms).toBe(250);
    });

    /**
     * Exits directly, and with a failure code. This used to call the same
     * finish() the drain does, whose pool.end() only calls back once every
     * checked-out client has been released — so a query still running
     * (statement_timeout is 15s, see db.ts) kept the process alive for as long
     * again after "exiting anyway" had been logged, and it then reported
     * success. The drain did not finish; the exit code should say so.
     */
    it("exits 1 without waiting for the pool when it fires", () => {
      const h = harness();

      h.shutdown("SIGTERM");
      h.clock.scheduled[0]!.handler();

      expect(h.exit).toHaveBeenCalledWith(1);
      expect(h.pool.ending).toBe(false);
      expect(h.logger.error).toHaveBeenCalledWith(
        `Graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms, exiting anyway.`,
      );
    });

    // Even on a crash, whose own code is already 1 — this asserts the path,
    // not the coincidence.
    it("still reports failure when a signal's drain overran", () => {
      const h = harness();

      h.shutdown("SIGTERM");
      h.clock.scheduled[0]!.handler();

      expect(h.exit).toHaveBeenCalledWith(1);
      expect(h.exit).toHaveBeenCalledTimes(1);
    });

    it("is cancelled when the drain finishes in time", () => {
      const h = harness();

      h.shutdown("SIGTERM");
      h.server.drained();

      expect(h.clock.clearTimeout).toHaveBeenCalledWith(
        h.clock.scheduled[0]!.timer,
      );
    });

    /**
     * Both halves can happen: a drain that completes just after the fallback
     * fired would otherwise call pool.end() a second time, which hands its
     * callback "Called end on pool more than once" — and that callback exits.
     */
    it("leaves finish idempotent when the drain lands after it fired", () => {
      const h = harness();

      h.shutdown("SIGTERM");
      h.clock.scheduled[0]!.handler();
      h.server.drained();
      h.server.drained();

      expect(h.pool.end).toHaveBeenCalledTimes(1);
      expect(h.clearCaches).toHaveBeenCalledTimes(1);
    });
  });
});
