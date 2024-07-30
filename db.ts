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
 * The pg_trgm score at or above which the "%" operator calls two strings
 * similar — the threshold every fuzzy title search on the site matches at.
 *
 * It is a *session* setting, and that is the whole reason it is here rather
 * than in models/game.ts. "%" takes no threshold argument, so every search
 * used to check out a client, BEGIN, set_config(..., is_local => true), run
 * the statement and COMMIT: four round trips for one query, on the hottest
 * path the catalogue has, and a connection held out of the pool for all of
 * them. Set once per connection at connect time, the search is a plain
 * pool.query again and the value cannot leak between requests because every
 * connection carries the same one.
 *
 * Sent as a startup parameter rather than as a "SET" on a connect handler,
 * so a client cannot serve a query before it has been configured — the same
 * reasoning as `statement_timeout` above, which pg also sends at startup.
 * .env.example already refuses pgbouncer-style transaction-mode poolers for
 * exactly this reason: they accept no startup parameters.
 *
 * Exported because models/game.ts needs the number, and it imports it: the
 * suggestion queries deliberately match at a much looser threshold and set
 * their own with SET LOCAL, and SUGGESTION_SIMILARITY_THRESHOLD is clamped
 * against this one so that the fallback for a search that found nothing can
 * never end up matching more strictly than the search it stands in for. The
 * comment there said as much while the two numbers sat in separate files with
 * nothing between them; now the relationship is an expression.
 */
export const SEARCH_SIMILARITY_THRESHOLD = 0.28;

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

  // See SEARCH_SIMILARITY_THRESHOLD. Postgres accepts a "prefix.name" setting
  // it does not recognise yet as a placeholder, so this is safe even on a
  // connection made before pg_trgm has been loaded into the backend.
  options: `-c pg_trgm.similarity_threshold=${SEARCH_SIMILARITY_THRESHOLD}`,
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
