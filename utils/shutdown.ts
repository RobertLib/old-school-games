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
 * How long the drain is given before the process leaves anyway.
 *
 * Fly sends SIGTERM and follows it with SIGKILL after kill_timeout, which
 * fly.toml sets to fifteen seconds. Five is comfortably under that — it used
 * to *equal* the platform's default of five, so the SIGKILL landed the moment
 * this fallback began — and a request still running after five seconds is
 * not going to finish anyway.
 */
export const SHUTDOWN_TIMEOUT_MS = 5_000;

export interface ShutdownOptions {
  server: ShutdownServer;
  pool: ShutdownPool;
  logger: ShutdownLogger;
  /**
   * Whatever else is keeping this process alive on its own schedule — the
   * pruning interval and the rate-limit sweeper in index.ts. Called once, at
   * the start of the first drain.
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
    stopTimers,
    clearCaches,
    timeoutMs = SHUTDOWN_TIMEOUT_MS,
    timers = nodeTimers,
    exit = (code: number) => process.exit(code),
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
    if (shuttingDown) {
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

    const finish = (): void => {
      if (finished) return;

      finished = true;

      clearCaches?.();
      pool.end(() => {
        logger.info("Database pool closed.");
        exit(exitCode);
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
      exit(1);
    }, timeoutMs);

    // unref'd so the timer cannot by itself be the reason the process is still
    // alive: if the drain finishes first there is nothing left to wait for.
    forceExit.unref();

    // server.close() waits for open connections but does not close the idle
    // ones, so a browser holding a keep-alive socket kept the process up until
    // that socket's own timeout — every deploy paid for it. Available since
    // Node 18.2; guarded because the suite mounts index.ts's app elsewhere.
    server.closeIdleConnections?.();

    server.close(() => {
      timers.clearTimeout(forceExit);
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
