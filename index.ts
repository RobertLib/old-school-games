import { fileURLToPath } from "url";
import path from "path";
import logger from "./utils/logger.ts";
import pool from "./db.ts";
import { cache } from "./middlewares/sidebar-data.ts";
import Game from "./models/game.ts";
import { findPendingMigrations } from "./utils/migrations.ts";
import {
  startRateLimitPruning,
  stopRateLimitPruning,
} from "./utils/rate-limit-store.ts";
import { syncCacheEpoch } from "./utils/cache-epoch.ts";
import app from "./app.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Daily housekeeping for the data this app ages out: the "plays" table, which
 * nothing used to clean up, and the IP address on a vote, which nothing used
 * to either. Both windows live in models/game.ts.
 *
 * It runs on boot as well as on the interval, because machines here are
 * stopped when idle and started on demand (see fly.toml) — a daily timer
 * alone would rarely live long enough to fire. A failure is logged and
 * dropped: this must never be what takes the site down.
 *
 * The two are independent, so one failing must not skip the other — hence a
 * try/catch each rather than one around the pair.
 */
async function pruneExpiredData(): Promise<void> {
  try {
    const removed = await Game.prunePlays();

    if (removed > 0) {
      logger.info(`Pruned ${removed} play records past the retention window.`);
    }
  } catch (error) {
    logger.error("Play pruning failed:", error);
  }

  try {
    const scrubbed = await Game.pruneRatingIps();

    if (scrubbed > 0) {
      logger.info(`Cleared the IP address from ${scrubbed} expired votes.`);
    }
  } catch (error) {
    logger.error("Rating IP pruning failed:", error);
  }
}

/**
 * Says so, loudly, when this process is running against a schema older than
 * the code.
 *
 * Nothing used to. Migrations are applied by one thing only — the release
 * command in fly.toml — so on Fly a failed migration aborts the deploy and
 * the mismatch cannot reach production. Everywhere else there was no check at
 * all: `npm run dev` and `npm start` boot happily against a database several
 * migrations behind, /healthz answers "up" because Postgres is reachable, and
 * the only evidence is whichever query first names a column that is not there.
 *
 * Both halves of that have already happened here. A "rate_limits" table that
 * did not exist yet turned every limiter on the site off — silently, because
 * all five pass `passOnStoreError` — leaving one line every ten minutes in
 * error.log as the sole sign. And Game.pruneRatingIps failed on every boot
 * against a "ratings" table with no "createdAt".
 *
 * A warning rather than a refusal to start, deliberately, and for the reason
 * written down at /healthz in app.ts: this app is built to outlive its
 * database being unreachable, and exiting here would turn a stale schema —
 * which usually still serves most of the site — into a machine that cannot
 * boot at all. The line is logged at error level so it lands in error.log and
 * on stderr, which is where the consequences show up too.
 *
 * It cannot tell a stale database from an unreachable one, so anything other
 * than a missing bookkeeping table is reported as "could not check" rather
 * than as pending work.
 */
async function warnOnPendingMigrations(): Promise<void> {
  try {
    const pending = await findPendingMigrations(
      pool,
      path.join(__dirname, "migrations"),
    );

    if (pending.length > 0) {
      logger.error(
        `Database is behind the code: ${pending.length} migration(s) not applied ` +
          `(${pending.join(", ")}). Run "npm run migrate". ` +
          `Queries naming anything these add will fail until it is.`,
      );
    }
  } catch (error) {
    logger.error("Could not check which migrations have been applied:", error);
  }
}

void warnOnPendingMigrations();

// Reads the shared cache epoch before the first request can, so the process
// knows the value its caches were built under. The first sync only adopts
// the number it finds; a request that filled a cache ahead of it would have
// left this machine unable to tell a later bump from the value it started
// with. The middleware in app.ts does the same on every interval after this.
void syncCacheEpoch();

void pruneExpiredData();

const pruneTimer = setInterval(() => void pruneExpiredData(), PRUNE_INTERVAL_MS);

// Sweeps rate-limit windows that have run out. Started here rather than in
// app.ts so that mounting the app under test does not start a timer.
startRateLimitPruning();

/**
 * How long the drain below is given before the process leaves anyway.
 *
 * Fly sends SIGTERM and follows it with SIGKILL after kill_timeout, which
 * fly.toml sets to fifteen seconds. Five is comfortably under that — it used
 * to *equal* the platform's default of five, so the SIGKILL landed the moment
 * this fallback began — and a request still running after five seconds is
 * not going to finish anyway.
 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

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

  clearInterval(pruneTimer);
  stopRateLimitPruning();

  // Nothing is left to answer once this resolves, so the pool goes either way
  // — through server.close() below when the drain finishes, or through the
  // timer when it does not. Idempotent because both of those can happen: a
  // drain that completes just after the timer fired would otherwise call
  // pool.end() a second time.
  let finished = false;

  const finish = (): void => {
    if (finished) return;

    finished = true;

    cache.clear();
    pool.end(() => {
      logger.info("Database pool closed.");
      process.exit(exitCode);
    });
  };

  const forceExit = setTimeout(() => {
    logger.error(
      `Graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms, exiting anyway.`,
    );
    // Exits directly, and with a failure code. This used to call finish(),
    // whose pool.end() only calls back once every checked-out client has been
    // released — so a query still running (statement_timeout is 15s, see
    // db.ts) kept the process alive for as long again after "exiting anyway"
    // had been logged, and it then reported success. The drain did not
    // finish; the exit code should say so.
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  // unref'd so the timer cannot by itself be the reason the process is still
  // alive: if the drain finishes first there is nothing left to wait for.
  forceExit.unref();

  // server.close() waits for open connections but does not close the idle
  // ones, so a browser holding a keep-alive socket kept the process up until
  // that socket's own timeout — every deploy paid for it. Available since
  // Node 18.2; guarded because the suite mounts this module's app elsewhere.
  server.closeIdleConnections?.();

  server.close(() => {
    clearTimeout(forceExit);
    finish();
  });
}

// SIGINT as well as SIGTERM, so Ctrl+C in development takes the same path as
// a deploy rather than dropping the pool on the floor.
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/**
 * The two ways this process can be left holding an error nobody caught.
 *
 * Neither was handled. An uncaught exception takes Node down by itself, but
 * it does so without running any of the draining below: open requests are
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
 * the choice made for a database that cannot answer (see warnOnPendingMigrations
 * and /healthz): an unreachable Postgres leaves this process in a state it
 * is built for, where an error nobody caught leaves it in one nobody has
 * reasoned about.
 */
function crash(kind: string, error: unknown): void {
  logger.error(
    `${kind}:`,
    error instanceof Error ? (error.stack ?? error.message) : error,
  );

  shutdown(kind, 1);
}

process.on("unhandledRejection", (reason) =>
  crash("Unhandled promise rejection", reason),
);
process.on("uncaughtException", (error) => crash("Uncaught exception", error));
