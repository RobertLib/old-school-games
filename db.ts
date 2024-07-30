import pg from "pg";
import logger from "./utils/logger.ts";

const { Pool } = pg;

/**
 * How long a single statement may run before Postgres cancels it.
 *
 * Server-side rather than client-side (`query_timeout`) on purpose: a session
 * can lift it with "SET statement_timeout = 0", which is what migrate.ts does
 * — creating an index on a grown table legitimately takes longer than any
 * page view should.
 */
const STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Refuses to boot a production process with nowhere to connect to.
 *
 * Left unset, node-postgres falls back to libpq's own defaults — the local
 * Unix socket as the current OS user — so a deploy missing this variable
 * does not fail here. It starts, answers /healthz with "up", and reports
 * every query as a connection error against a database that was never meant
 * to be there. This is the same guard app.ts puts on SESSION_SECRET, for the
 * same reason: a misconfiguration should be a refusal at boot, not a puzzle
 * in the logs.
 *
 * Outside production the fallback is the point: tests/setup.ts leans on it,
 * and so does a stock `createdb` on a developer's machine.
 */
if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL environment variable is required in production",
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // Explicit rather than left to the default 10, because the number matters
  // here: sidebar-data.ts asks for six lists at once, and the session store
  // and the route's own queries come out of the same pool.
  max: 10,

  // Without this, `pool.connect()` waits forever for a free client — so a
  // handful of slow queries turned into an unbounded pile-up of requests
  // rather than a few fast failures. Every caller that matters treats a
  // failed query as a blanked widget, not a dead page.
  //
  // Two seconds rather than ten. The wait is paid per query, and a page
  // renders several of them, so ten seconds' worth of "no connection yet"
  // was tens of seconds of a request hanging while the database was away —
  // on a site whose whole answer to an outage is to render the widget blank
  // and move on. Nothing here is worth waiting ten seconds for a socket
  // that is not coming; /healthz already gives the database two (see
  // HEALTH_DB_TIMEOUT_MS in app.ts) for exactly this reasoning.
  connectionTimeoutMillis: 2_000,

  idleTimeoutMillis: 30_000,

  statement_timeout: STATEMENT_TIMEOUT_MS,
});

/**
 * Required, not optional: pg's Pool is an EventEmitter that emits "error" when
 * an *idle* client fails — a Postgres restart, a failover, a dropped
 * connection. An EventEmitter with no "error" listener makes Node throw, so
 * this used to take the whole process down.
 *
 * Machines here are stopped when idle and started on demand (see fly.toml), so
 * connections being severed underneath the pool is the ordinary case rather
 * than an edge one. pg discards the broken client itself; there is nothing to
 * do but say so.
 */
pool.on("error", (error) => {
  logger.error("Idle database client error:", error);
});

export default pool;
