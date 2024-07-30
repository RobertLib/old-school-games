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
  connectionTimeoutMillis: 10_000,

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
