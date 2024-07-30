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
const DEFAULT_TEST_DATABASE_URL = "postgresql:///old_school_games_test";

/**
 * Whatever TEST_DATABASE_URL says, spelled out rather than defaulted through.
 *
 * `??` only falls back on undefined and null, so an *empty* TEST_DATABASE_URL
 * — a shell exporting it from an unset variable, a CI secret that resolved to
 * nothing, a `TEST_DATABASE_URL= npm test` — went through as "" and libpq
 * reads an empty connection string as "use all of my defaults": the local
 * socket, as the current OS user, against a database named after them. That is
 * a developer's own database, and the next two things this file does to it are
 * TRUNCATE and DROP TABLE. An empty value is a misconfiguration, so it is
 * refused rather than interpreted.
 */
const configured = process.env.TEST_DATABASE_URL;

if (configured !== undefined && configured.trim() === "") {
  throw new Error(
    "TEST_DATABASE_URL is set but empty. An empty connection string is not " +
      "the default — libpq reads it as 'connect to my own defaults', which " +
      "is whatever database the current OS user owns. Unset it to use " +
      `${DEFAULT_TEST_DATABASE_URL}, or give it a real URL.`,
  );
}

const databaseUrl = configured ?? DEFAULT_TEST_DATABASE_URL;

/**
 * The name of the database a connection string points at, or undefined when
 * it names none.
 *
 * URL rather than a regex, so "?sslmode=require", a userinfo containing a
 * slash-escaped password and the socket-directory form
 * ("postgresql:///db?host=/var/run/postgresql") all give the same answer —
 * the pathname, which is only ever the database name. Percent-decoded,
 * because a database name may legally carry a character that had to be
 * escaped to sit in a URL.
 */
function databaseName(url: string): string | undefined {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  const name = decodeURIComponent(parsed.pathname).replace(/^\//, "");

  return name === "" ? undefined : name;
}

/**
 * Refuses to run the suite against anything that is not obviously a test
 * database.
 *
 * Nothing used to check. dropEverything() drops every table and every enum in
 * the public schema, and cleanTestData() truncates nine tables with CASCADE —
 * against whichever database TEST_DATABASE_URL happened to name. One
 * `TEST_DATABASE_URL=$DATABASE_URL npm test`, one stale export left in a
 * shell, one copy-pasted production URL, and the suite empties it without a
 * word: both of those are ordinary operations here, and neither has any way
 * of telling that it is in the wrong place.
 *
 * The check is the name, because the name is the one part of a connection
 * string a person chooses on purpose. Both spellings this project ships pass
 * it — the default above and the
 * "postgresql://postgres:postgres@localhost:5432/old_school_games_test" the
 * workflow exports — and so does any name with "test" anywhere in it. A
 * production database is not called that.
 */
const name = databaseName(databaseUrl);

if (name === undefined) {
  throw new Error(
    `TEST_DATABASE_URL (${databaseUrl}) names no database. The suite drops ` +
      "and truncates whatever it connects to, so it will not connect to a " +
      "server's default database.",
  );
}

if (!/test/i.test(name)) {
  throw new Error(
    `Refusing to run the test suite against the database "${name}". This ` +
      "file truncates every table it knows about and drops the whole public " +
      "schema when there is no migrations table, so it only runs against a " +
      'database whose name says "test" — rename it, or point ' +
      `TEST_DATABASE_URL at one (default: ${DEFAULT_TEST_DATABASE_URL}).`,
  );
}

process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = "test";

const { Pool } = pg;

// A pool of this file's own, so the schema work cannot be pointed at
// anything but the test database — db.ts reads DATABASE_URL at import time
// and this file is what sets it.
//
// It is ended once the migrations are done, at the bottom of this file.
// Nothing else here uses it, and setup.ts runs once per *test file*: a pool
// left open is two idle connections held for the whole run, times however
// many files the integration project has, against a Postgres that grants a
// hundred. That is how a suite ends up reporting pool timeouts in whichever
// test happened to be running when the limit was reached.
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
async function withoutStatementTimeout<T>(
  client: pg.PoolClient,
  run: () => Promise<T>,
): Promise<T> {
  await client.query("SET statement_timeout = 0");

  try {
    return await run();
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
    // The same bound migrate.ts puts on its wait, and for the same reason: an
    // `npm run migrate` left at a prompt, or a DDL lock some other session is
    // sitting on, used to hang the whole suite here with no output at all —
    // vitest just never printed a result. lock_timeout covers
    // pg_advisory_lock (see the comment in migrate.ts), so now it is a
    // readable failure five minutes in. The RESET ALL in the finally below
    // clears it before the client goes back to the pool.
    await client.query("SET lock_timeout = '5min'");
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

    const run = await withoutStatementTimeout(client, async () => {
      await ensureMigrationsTable(client);
      return applyPendingMigrations(client, MIGRATIONS_DIR);
    });

    // "Ahead of this build" is a success for a deploy — it is what a rollback
    // to an earlier image looks like, and expand/contract makes the old code
    // safe on the newer schema (see verifyAppliedMigrations) — but it is the
    // wrong answer for a suite. The runner only warns about it, and the logger
    // writes nothing under NODE_ENV=test, so a test database carrying a
    // migration this checkout does not have — one applied from another branch,
    // or a new file renamed after a run had applied it — used to be refused
    // here and started passing in silence instead, with every test then
    // running against a schema the code under test was never written for.
    if (run.ahead.length > 0) {
      throw new Error(
        `The test database has applied ${run.ahead.join(", ")}, which ` +
          `${run.ahead.length === 1 ? "is" : "are"} not in ${MIGRATIONS_DIR}. ` +
          "It was migrated by a different checkout (another branch, or a " +
          "migration renamed after it ran), so its schema is not the one this " +
          "code expects. Drop and recreate the test database.",
      );
    }
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

    // The same RESET ALL the real runner does (see migrate.ts), and for the
    // same reason: release() does not reset session state, so whatever a
    // migration set at session level outlives the checkout on this pooled
    // client. 0030 sets the time zone with a non-LOCAL "SET TIME ZONE", and
    // that is not hypothetical here — every test that reads a timestamp back
    // would be interpreting it under the migration's zone or the server's
    // depending on which client it was handed, which is a flake nobody would
    // trace to a migration. Listing the settings by hand is how that one came
    // to be missed, so nothing is named.
    try {
      await client.query("RESET ALL");
    } catch {
      // Housekeeping must not mask a real migration failure. A connection
      // this cannot reset is already broken.
    }

    client.release();
  }
}

// Run migrations before any tests start
await runTestMigrations();

// And then let the connections go. Everything past this point talks to the
// database through db.ts's pool, which DATABASE_URL above has already pointed
// at the test database; this one has nothing left to do.
await testDb.end();
