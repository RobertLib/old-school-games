import { fileURLToPath } from "url";
import path from "path";
import pg from "pg";
// The real runner's own pieces, not a second copy of them. This file used to
// reimplement the file listing, the bookkeeping table and the apply loop —
// without a transaction per file and without lifting the statement timeout —
// so the schema the suite ran against was built by code that could drift from
// the code a deploy runs. See utils/migrations.ts.
import {
  MIGRATION_LOCK_KEY,
  applyPendingMigrations,
  ensureMigrationsTable,
} from "../utils/migrations.ts";

// Set environment variables BEFORE any database connections.
//
// The default names nothing but the database. No host, user or password, so
// libpq fills all three in from its own defaults — the local Unix socket as
// the current OS user — which is what a stock `createdb old_school_games_test`
// leaves you able to connect to. It used to spell out one developer's
// username and password, which worked on exactly one machine and told
// everybody else's checkout to authenticate as somebody who does not exist
// there. The "?schema=public" it also carried was a Prisma parameter that
// node-postgres has never read.
//
// CI, and anyone whose Postgres does not look like that, set
// TEST_DATABASE_URL instead; the standard PG* variables (PGHOST, PGUSER,
// PGPASSWORD) are honoured too, because that is what leaving them out means.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql:///old_school_games_test";
process.env.NODE_ENV = "test";

const { Pool } = pg;

// Create a new pool specifically for tests to ensure it uses the test database
const testDb = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Every table the suite writes to. Order no longer matters — TRUNCATE below
 * takes them all in one statement — but they are listed in dependency order
 * anyway, because that is the order a reader expects and the order the
 * DELETEs this replaced needed.
 *
 * "plays" used to be missing, so play counts accumulated across runs, and so
 * did "rate_limits" — which is keyed by IP and shared by every limiter, so a
 * whole previous run's request count carried into the next one and eventually
 * answered the suite's own requests with a 429. "session" was missing too:
 * express-session writes a row per logged-in request and nothing removed one,
 * so the table grew with every run.
 */
const TABLES_TO_CLEAN = [
  "comments",
  "ratings",
  "plays",
  "rate_limits",
  "game_of_the_week",
  "news",
  "games",
  "users",
  "session",
];

/** Postgres's "relation does not exist". */
const UNDEFINED_TABLE = "42P01";

/**
 * Empties every table the suite writes to and puts the id sequences back to 1.
 *
 * One TRUNCATE rather than a DELETE per table, and the difference is not
 * speed. The loop this replaced wrapped each statement in a `try {} catch {}`
 * that swallowed *everything* — the comment said "table might not exist yet",
 * but the catch could not tell that apart from a DELETE that was refused or
 * that blocked. So a cleanup which silently did not happen looked exactly
 * like one that did, and the leftover rows surfaced later as an assertion
 * failing in some unrelated test that expected an empty table. That is a
 * flake with no diagnostic trail at all: the failure is nowhere near the
 * cause, and re-running usually hides it.
 *
 * TRUNCATE fixes the mechanism as well as the reporting:
 *
 *   - It is one statement, so it cannot half-apply. The DELETEs could, and
 *     the FK order made that worse: "plays" failing quietly meant the "games"
 *     DELETE was then refused by the foreign key, quietly, leaving both.
 *   - CASCADE follows the foreign keys itself, so the list above no longer
 *     has to stay in dependency order to be correct. It also reaches the two
 *     tables nothing ever cleaned: "game_slugs" and "news_slugs" reference
 *     "games" and "news", so slug history used to accumulate across every run
 *     the suite had ever made on that database. Nothing but "migrations" is
 *     left standing, and that has no foreign key into any of these — which is
 *     what keeps the schema from being re-applied on the next run.
 *   - RESTART IDENTITY resets the sequences in the same breath, replacing a
 *     second hand-maintained list of "<table>_id_seq" names that had to be
 *     kept in step with the first one.
 *
 * Only a missing table is tolerated, and only where it is genuinely expected:
 * this runs before applyPendingMigrations, so a table a pending migration has
 * not created yet is not an error. Those are filtered out by asking the
 * catalogue rather than by catching, so nothing else hides behind the same
 * handler. A truncation that fails for any other reason now throws, which
 * fails the setup file — loudly, and in the file that caused it.
 */
async function cleanTestData(client: pg.PoolClient) {
  const { rows } = await client.query(
    `SELECT "tablename" FROM "pg_tables"
     WHERE "schemaname" = 'public' AND "tablename" = ANY($1)`,
    [TABLES_TO_CLEAN],
  );

  const present = rows.map((row) => row.tablename as string);

  if (present.length === 0) return;

  const quoted = present.map((table) => `"${table}"`).join(", ");

  // In a transaction so that "SET LOCAL" means something — outside one it
  // applies to nothing and Postgres only warns — and so the truncation is all
  // or nothing even against a signal arriving mid-run. TRUNCATE is
  // transactional here, unlike in some other databases.
  await client.query("BEGIN");

  try {
    // Fails fast rather than waiting behind a lock another connection is
    // holding. A cleanup that cannot get the table is exactly the case the
    // old catch swallowed, and a five-second error is a better symptom than a
    // hung run.
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(`TRUNCATE ${quoted} RESTART IDENTITY CASCADE`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    // The one tolerable failure, and it is a race rather than a mistake: a
    // table the catalogue listed a moment ago can be gone by now if something
    // else is rebuilding the schema. Everything else is a cleanup that did
    // not happen, which the caller must hear about.
    if ((error as { code?: string }).code !== UNDEFINED_TABLE) throw error;
  }
}

/** Where the migrations are, from here rather than from the project root. */
const MIGRATIONS_DIR = path.join(__dirname, "../migrations");

/**
 * Lifts the pool's statement timeout for this session, as the real runner
 * does.
 *
 * This pool is built in this file and carries no statement_timeout of its
 * own, so today the lift changes nothing. It is here because the divergence
 * between the two runners is the thing being fixed: whatever a deploy gives a
 * migration, the suite should give it too, and the next person to add a
 * connection parameter above should not have to notice this.
 */
async function withoutStatementTimeout(
  client: pg.PoolClient,
  run: () => Promise<void>,
): Promise<void> {
  await client.query("SET statement_timeout = 0");

  try {
    await run();
  } finally {
    try {
      await client.query("RESET statement_timeout");
    } catch {
      // Housekeeping must not mask a real migration failure.
    }
  }
}

/**
 * Throws away whatever a previous, differently-shaped run left in the schema.
 *
 * Only reached when there is no "migrations" table, which means nothing here
 * knows what has been applied — so the only safe starting point is an empty
 * schema.
 */
async function dropEverything(client: pg.PoolClient) {
  const { rows: tables } = await client.query(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `);

  for (const row of tables) {
    await client.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
  }

  const { rows: types } = await client.query(`
    SELECT typname
    FROM pg_type
    WHERE typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      AND typtype = 'e'
  `);

  for (const row of types) {
    await client.query(`DROP TYPE IF EXISTS "${row.typname}" CASCADE`);
  }
}

/**
 * Brings the test database up to the current schema before any test runs.
 *
 * The advisory lock is the real runner's own key, so a suite and a
 * `npm run migrate` that happen to meet on one database wait for each other
 * rather than interleaving.
 *
 * The two branches differ only in how they get to an empty set of rows: a
 * database that has been used before is truncated, one that has not is
 * cleared outright. Both then hand over to the shared runner, which is the
 * whole point — the bookkeeping table, the checksum verification and the
 * transaction per file are the ones a deploy uses, not a second version of
 * them maintained here.
 */
async function runTestMigrations() {
  const client = await testDb.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    const { rows } = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'migrations'
      ) AS exists
    `);

    if (rows[0].exists) {
      // Before the migrations, not after: a table a pending migration has not
      // created yet is not something to truncate.
      await cleanTestData(client);
    } else {
      await dropEverything(client);
    }

    await withoutStatementTimeout(client, async () => {
      await ensureMigrationsTable(client);
      await applyPendingMigrations(client, MIGRATIONS_DIR);
    });
  } catch (error) {
    console.error("Test migration error:", error);
    throw error;
  } finally {
    // Session-level, so it outlives the checkout and has to go back by hand.
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [
        MIGRATION_LOCK_KEY,
      ]);
    } catch {
      // The lock goes when the session does.
    }

    client.release();
  }
}

// Run migrations before any tests start
await runTestMigrations();
