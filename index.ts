import { fileURLToPath } from "url";
import path from "path";
import logger from "./utils/logger.ts";
import pool from "./db.ts";
import { cache } from "./middlewares/sidebar-data.ts";
import Game from "./models/game.ts";
import Comment from "./models/comment.ts";
import { findPendingMigrations } from "./utils/migrations.ts";
import {
  startRateLimitPruning,
  stopRateLimitPruning,
} from "./utils/rate-limit-store.ts";
import { syncCacheEpoch } from "./utils/cache-epoch.ts";
import { createShutdown } from "./utils/shutdown.ts";
import app from "./app.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

// Express 5 hands a listen failure to this callback — it registers the
// callback on the server's "error" event as well as for "listening" — rather
// than letting it escape as an uncaught exception. Ignoring the argument meant
// an EADDRINUSE or an EACCES logged "Server is running" for a server that was
// not, reached neither crash handler below, and left the process alive
// indefinitely on the strength of the prune interval: a supervisor saw a
// healthy PID answering nothing and never restarted it. It is a crash, so it
// takes the crash path. `crash` is declared further down, and is in place long
// before either event can fire.
const server = app.listen(PORT, (error?: Error) => {
  if (error) {
    crash("Could not listen", error);
    return;
  }

  logger.info(`Server is running on port ${PORT}`);
});

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Daily housekeeping for the data this app ages out: the "plays" table, which
 * nothing used to clean up, the IP address on a vote, which nothing used to
 * either, and the source recorded with a comment, which the privacy policy
 * promises is gone after a month. The first two windows live in
 * models/game.ts, the third in models/comment.ts.
 *
 * It runs on boot as well as on the interval, because machines here are
 * stopped when idle and started on demand (see fly.toml) — a daily timer
 * alone would rarely live long enough to fire. A failure is logged and
 * dropped: this must never be what takes the site down.
 *
 * The three are independent, so one failing must not skip the others — hence
 * a try/catch each rather than one around the lot.
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

  try {
    const cleared = await Comment.pruneSources();

    if (cleared > 0) {
      logger.info(`Cleared the source from ${cleared} expired comments.`);
    }
  } catch (error) {
    logger.error("Comment source pruning failed:", error);
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
 * Draining, wired to the real four.
 *
 * The logic itself is in utils/shutdown.ts, with every reason it is shaped the
 * way it is. It moved there because this file is the one the coverage list in
 * vitest.config.ts has to exclude — it listens on a port on import — so the
 * drain was the one piece of this app nothing could exercise, and each of the
 * comments over there records a bug found in production instead.
 *
 * The two timers are stopped at the start of the drain and the sidebar cache
 * is dropped once nothing is left to answer from it; both are passed in
 * because utils/shutdown.ts has no opinion about either.
 */
const { shutdown, crash } = createShutdown({
  server,
  pool,
  logger,
  // The connect-pg-simple store app.ts built, reached through app.locals for
  // the same reason everything else here is passed in rather than imported:
  // utils/shutdown.ts has no opinion about it. Its prune timer queries the
  // pool below on an interval of its own and nothing used to stop it — see
  // ShutdownStore over there.
  store: app.locals.sessionStore,
  stopTimers: () => {
    clearInterval(pruneTimer);
    stopRateLimitPruning();
  },
  clearCaches: () => cache.clear(),
});

// SIGINT as well as SIGTERM, so Ctrl+C in development takes the same path as
// a deploy rather than dropping the pool on the floor.
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) =>
  crash("Unhandled promise rejection", reason),
);
process.on("uncaughtException", (error) => crash("Uncaught exception", error));
