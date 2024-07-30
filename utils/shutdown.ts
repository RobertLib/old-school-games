/**
 * Draining the process, and the two ways it can be asked to.
 *
 * This used to live at the bottom of index.ts, which is the one file the
 * coverage list in vitest.config.ts has to exclude — it listens on a port the
 * moment it is imported. So the code that decides whether a deploy waits for
 * an in-flight request, whether the pool is closed, and what exit status a
 * supervisor reads was the one piece of this app that nothing could test, and
 * every comment below records a bug that was found in production rather than
 * by a run.
 *
 * Nothing here reaches for a module of its own: the server, the pool, the
 * logger, the timers and the way out of the process are all passed in. That
 * is what lets a test drive a second signal, a drain that finishes after the
 * fallback fired, or a pool that never calls back — none of which can be
 * provoked against the real ones without ending the test runner with them.
 * index.ts is left as the wiring that names the real four.
 */

/**
 * The part of http.Server this needs.
 *
 * closeIdleConnections is optional because it is: it arrived in Node 18.2,
 * and the suite mounts the app without a listener in front of it.
 */
export interface ShutdownServer {
  close(callback?: (error?: Error) => void): void;
  closeIdleConnections?(): void;
}

/**
 * The part of pg.Pool this needs — the callback form of end().
 *
 * The error parameter is optional here although pg declares it required: this
 * shape has to be satisfiable by a test double that ignores it, and pg's own
 * signature is still assignable to this one.
 */
export interface ShutdownPool {
  end(callback: (error?: Error) => void): void;
}

/**
 * The part of a connect-pg-simple store this needs.
 *
 * That store starts a prune timer when it is constructed and nothing ever
 * stopped it: a prune firing between pool.end() and the process leaving runs a
 * query against a pool that has gone, which the store reports through its
 * errorLog as a failure on the way out of every deploy that happens to land on
 * one. Its close() clears the timer and is synchronous.
 *
 * Optional throughout, because index.ts is not the only thing that builds the
 * drain — the suite drives it with fakes, and neither has a store.
 */
export interface ShutdownStore {
  close(): void;
}

/** The part of utils/logger.ts this needs. */
export interface ShutdownLogger {
  info(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** A scheduled timer, of which only unref() and cancellation are used. */
export interface ShutdownTimer {
  unref(): void;
}

/**
 * Scheduling, injected rather than taken from the global.
 *
 * A fake here is the only way a test can assert both that the fallback was
 * unref'd and what it does when it fires, without the case having to wait five
 * real seconds to find out.
 */
export interface ShutdownTimers {
  setTimeout(handler: () => void, ms: number): ShutdownTimer;
  clearTimeout(timer: ShutdownTimer): void;
}

const nodeTimers: ShutdownTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

/**
 * How long the last few log lines are given to reach the far end of a pipe
 * before the process leaves without them.
 *
 * A bound rather than an open wait, because the reader may be gone: a pipe
 * nobody is draining never drains, and a drain that hangs on its own logging
 * is a worse failure than a missing line.
 */
const FLUSH_TIMEOUT_MS = 1_000;

/**
 * Leaves the process, having given stdout and stderr a chance to be read.
 *
 * process.exit() is immediate and discards whatever is still sitting in a
 * stream's buffer — and whether anything is sitting there depends entirely on
 * what the stream is attached to. To a TTY, Node writes synchronously and
 * nothing is ever lost, which is why this never showed up in development. To a
 * *pipe* — which is what stdout is under Fly, under Docker, under a CI runner
 * and under anything that collects logs — writes are asynchronous, so
 * "Database pool closed." and, worse, the "Graceful shutdown exceeded …"
 * line and any error logged on the way out were being dropped on exactly the
 * deploys somebody would be reading the log to understand.
 *
 * exitCode is set before the wait rather than only passed to exit(): if the
 * loop happens to empty by itself while the flush is outstanding, Node leaves
 * on its own and has to leave with the right status.
 */
function flushThenExit(code: number): void {
  process.exitCode = code;

  // Counted rather than chained: the two streams flush independently, and the
  // extra count held here until the loop below is finished keeps an
  // already-empty pair from exiting before the other stream has been asked.
  let pending = 1;

  const done = (): void => {
    pending -= 1;

    if (pending === 0) process.exit(code);
  };

  for (const stream of [process.stdout, process.stderr]) {
    // Nothing buffered: a TTY, or a pipe that has kept up. "drain" would never
    // fire for it, so waiting on one would be waiting forever.
    if (stream.writableLength === 0) continue;

    pending += 1;
    stream.once("drain", done);
  }

  if (pending > 1) {
    // unref'd: if both streams drain first there is nothing left to wait for,
    // and this must not be the reason the process is still alive.
    setTimeout(() => process.exit(code), FLUSH_TIMEOUT_MS).unref();
  }

  done();
}

/**
 * How long the drain is given before the process leaves anyway.
 *
 * Fly sends fly.toml's kill_signal — SIGTERM, named there because the
 * platform's own default is SIGINT, which index.ts only happens to handle as
 * well — and follows it with SIGKILL after kill_timeout, which fly.toml sets
 * to fifteen seconds. Five is comfortably under that — it used to *equal* the
 * platform's default of five, so the SIGKILL landed the moment this fallback
 * began — and a request still running after five seconds is not going to
 * finish anyway.
 *
 * That collision outlived the fix for a while: kill_timeout sat below [env]
 * in fly.toml, which in TOML made it an environment variable rather than a
 * setting, so the platform's five went on applying until both keys moved
 * above the file's first table.
 */
export const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * How often, during a drain, the connections that have gone idle are closed.
 *
 * Short, because each tick is what lets server.close() finish: a keep-alive
 * socket that was busy when the drain began is only closed by a sweep after
 * its response has gone out. Cheap, because a sweep walks the open
 * connections and touches none that is busy.
 */
export const IDLE_SWEEP_MS = 100;

export interface ShutdownOptions {
  server: ShutdownServer;
  pool: ShutdownPool;
  logger: ShutdownLogger;
  /**
   * The session store, closed before the pool it queries is ended. See
   * ShutdownStore above for the error that leaving its timer running produced.
   */
  store?: ShutdownStore;
  /**
   * Whatever else is keeping this process alive on its own schedule — the
   * pruning interval and the rate-limit sweeper in index.ts. Called once, at
   * the start of the first drain.
   *
   * The retries of a failed cache-epoch bump are deliberately not among them:
   * their timers are unref'd, so they cannot hold the process open, and each
   * one checks that the pool has not been told to end before it queries (see
   * BUMP_RETRY_DELAYS_MS in utils/cache-epoch.ts). One that comes due during a
   * drain but before pool.end() still delivers its bump, which is the last
   * useful thing it can do.
   */
  stopTimers?: () => void;
  /** Dropped once nothing is left to answer from them. */
  clearCaches?: () => void;
  timeoutMs?: number;
  timers?: ShutdownTimers;
  exit?: (code: number) => void;
}

export interface ShutdownHandlers {
  /** Handles a signal, or a crash when a non-zero code is passed. */
  shutdown(signal: string, code?: number): void;
  /** Logs an error nobody caught and then drains with a failure code. */
  crash(kind: string, error: unknown): void;
}

export function createShutdown(options: ShutdownOptions): ShutdownHandlers {
  const {
    server,
    pool,
    logger,
    store,
    stopTimers,
    clearCaches,
    timeoutMs = SHUTDOWN_TIMEOUT_MS,
    timers = nodeTimers,
    exit = flushThenExit,
  } = options;

  let shuttingDown = false;

  /**
   * What the process leaves with once the drain finishes.
   *
   * A signal is a clean stop and reports success; a crash is not, and a
   * supervisor reading the exit status is the only thing that can tell the
   * difference. See crash() below.
   */
  let exitCode = 0;

  function shutdown(signal: string, code: number = 0): void {
    // Re-entrant otherwise, and a second signal is ordinary — a deploy that
    // sends SIGTERM twice, or an impatient Ctrl+C. The second pass used to call
    // server.close() and pool.end() again: both hand their callback an error
    // ("Called end on pool more than once"), both callbacks ignore it, and the
    // inner one exits 0 — so the repeat signal cut the first drain short and
    // reported success. It now only hurries the timer along.
    //
    // It can still *raise* the exit code, never lower it. A crash arriving
    // during a signal's drain used to return here before its code was looked
    // at, so an uncaught exception on the way out of a deploy was logged and
    // then reported to the supervisor as a clean stop.
    if (shuttingDown) {
      exitCode = Math.max(exitCode, code);
      logger.info(`${signal} received again, already shutting down.`);
      return;
    }

    shuttingDown = true;
    exitCode = code;

    logger.info(`${signal} received, shutting down gracefully...`);

    stopTimers?.();

    // Nothing is left to answer once this resolves, so the pool goes either way
    // — through server.close() below when the drain finishes, or through the
    // timer when it does not. Idempotent because both of those can happen: a
    // drain that completes just after the timer fired would otherwise call
    // pool.end() a second time.
    let finished = false;
    let exited = false;

    const finish = (): void => {
      if (finished) return;

      finished = true;

      clearCaches?.();

      // Before pool.end(), not after it and not never: the store's prune timer
      // queries this very pool, so a prune scheduled for the next tick would
      // otherwise fire against a pool that has been ended and report it as a
      // failure through errorLog — on the way out of a perfectly clean deploy.
      // Wrapped because nothing about draining should be stopped by a store
      // that objects to being closed twice.
      try {
        store?.close();
      } catch (error) {
        logger.error(
          "Closing the session store failed:",
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
      }

      pool.end(() => {
        logger.info("Database pool closed.");
        leave(exitCode);
      });
    };

    const forceExit = timers.setTimeout(() => {
      logger.error(
        `Graceful shutdown exceeded ${timeoutMs}ms, exiting anyway.`,
      );
      // Exits directly, and with a failure code. This used to call finish(),
      // whose pool.end() only calls back once every checked-out client has been
      // released — so a query still running (statement_timeout is 15s, see
      // db.ts) kept the process alive for as long again after "exiting anyway"
      // had been logged, and it then reported success. The drain did not
      // finish; the exit code should say so.
      leave(1);
    }, timeoutMs);

    // unref'd so the timer cannot by itself be the reason the process is still
    // alive: if the drain finishes first there is nothing left to wait for.
    forceExit.unref();

    let sweep: ShutdownTimer | undefined;

    /**
     * The only way out, taken once however many of the paths above reach it.
     *
     * The fallback is cancelled here — once the pool has actually closed —
     * and not when the listener did, which is where it used to be cleared.
     * That left pool.end() with no bound at all: it waits for every
     * checked-out client, so a query still running at SIGTERM (a boot-time
     * prune, a rate-limit sweep, an epoch bump) could stretch the drain
     * towards the platform's SIGKILL with nothing left to log why.
     */
    function leave(code: number): void {
      if (exited) return;

      exited = true;
      timers.clearTimeout(forceExit);
      if (sweep) timers.clearTimeout(sweep);
      exit(code);
    }

    /**
     * Closes whatever has gone idle, and keeps doing so until the listener
     * is closed.
     *
     * server.close() waits for open connections but does not close the idle
     * ones, so a browser holding a keep-alive socket kept the process up until
     * that socket's own timeout — every deploy paid for it. One call at the
     * start fixed the sockets idle *at that moment* and no others: a socket
     * busy when the signal arrived answers its request with
     * "Connection: keep-alive" and then sits idle for the server's
     * keepAliveTimeout, five seconds — which is the fallback above, so under
     * any traffic at all (the Fly proxy pools its connections to this process)
     * the drain never finished first. Every such deploy ended in "Graceful
     * shutdown exceeded", exit 1 and a pool that was never ended, and the
     * sockets went on accepting requests right up to the forced exit. Swept
     * on a short interval instead, each one closes as soon as its last
     * response is out.
     *
     * Available since Node 18.2; guarded because the suite mounts index.ts's
     * app elsewhere, and a server without it has nothing to sweep.
     */
    function sweepIdle(): void {
      server.closeIdleConnections?.();

      sweep = timers.setTimeout(sweepIdle, IDLE_SWEEP_MS);
      sweep.unref();
    }

    if (server.closeIdleConnections) sweepIdle();

    server.close(() => {
      // Nothing is left open to sweep.
      if (sweep) timers.clearTimeout(sweep);
      sweep = undefined;
      finish();
    });
  }

  /**
   * The two ways this process can be left holding an error nobody caught.
   *
   * Neither was handled. An uncaught exception takes Node down by itself, but
   * it does so without running any of the draining above: open requests are
   * cut off mid-response, the checked-out clients are dropped rather than
   * released, and the only record is Node's own stack trace on stderr —
   * nowhere near error.log, which is where everything else this app considers
   * a failure is written. An unhandled rejection is worse, because Node's
   * default for it is also to exit: a rejected promise nothing awaited — a
   * `void`ed cache bump against a database that has gone away — could take
   * the whole site down as abruptly and with as little explanation.
   *
   * So both are logged the way every other failure here is and then handed to
   * the shutdown above, which closes the listener, drains what is in flight
   * and ends the pool before leaving — with a failure code, because this is
   * not a clean stop and the platform restarting the machine should be able
   * to tell. shutdown() is already re-entrant, so a second crash arriving
   * during the drain only says so rather than starting another one.
   *
   * Exiting rather than carrying on is deliberate, and it is the opposite of
   * the choice made for a database that cannot answer (see
   * warnOnPendingMigrations in index.ts and /healthz in app.ts): an
   * unreachable Postgres leaves this process in a state it is built for, where
   * an error nobody caught leaves it in one nobody has reasoned about.
   */
  function crash(kind: string, error: unknown): void {
    logger.error(
      `${kind}:`,
      error instanceof Error ? (error.stack ?? error.message) : error,
    );

    shutdown(kind, 1);
  }

  return { shutdown, crash };
}
