import { fileURLToPath } from "url";
import path from "path";
import db from "./db.ts";
import {
  MIGRATION_LOCK_KEY,
  applyPendingMigrations,
  ensureMigrationsTable,
} from "./utils/migrations.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Applies every migration the database has not seen yet, in filename order,
 * each one inside its own transaction. Throws on the first failure so the
 * caller can decide what a failed migration means.
 *
 * The reading, hashing and applying live in utils/migrations.ts, which
 * tests/setup.ts shares — that file used to carry a second implementation of
 * all of it. What is left here is the part that is this script's own: one
 * client, one advisory lock, and the statement timeout lifted around them.
 *
 * Everything runs on one checked-out client: BEGIN and COMMIT issued through
 * the pool can land on different connections, which would leave a half-applied
 * migration committed.
 *
 * A session-level advisory lock holds the whole run, so two of these cannot
 * apply the same file at once. Fly runs the release command once per deploy,
 * but nothing stopped a second deploy — or somebody running `npm run migrate`
 * by hand alongside one — from reading the same "not yet applied" list and
 * both executing it; the UNIQUE on "name" would then fail one of them
 * partway through, after its DDL had already run.
 */
export async function runMigrations(): Promise<void> {
  const client = await db.connect();

  try {
    // The pool caps every statement at a page view's worth of time (see
    // db.ts). A migration is not a page view — adding an index to a grown
    // table can legitimately run for minutes — and being cancelled halfway
    // would fail the deploy for no reason. Lifted for this session only.
    //
    // Before the lock, not after: waiting for another deploy to finish is
    // itself a statement, and the 15-second cap would have cancelled it.
    await client.query("SET statement_timeout = 0");

    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    await ensureMigrationsTable(client);

    await applyPendingMigrations(client, path.join(__dirname, "migrations"));
  } finally {
    // Released explicitly: the client goes back to the pool rather than
    // closing, and a session-level lock outlives the checkout.
    //
    // A failure here is swallowed on purpose. It is housekeeping — Postgres
    // drops the lock by itself when the connection closes — and throwing out
    // of a finally would replace the migration error the caller needs to see
    // with a meaningless one.
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } catch {
      // Nothing to do; the lock goes when the session does.
    }

    // Put the cap back before the connection is reused. release() does not
    // reset session state, and db.ts applies statement_timeout only as a
    // connection parameter at connect time — so the lift above would have
    // outlived this function on that pooled client, leaving one connection
    // in the pool willing to run a page view's query forever. Nothing hits
    // that today (migrate.ts ends with db.end()), but runMigrations is
    // exported, and an in-process caller would poison the pool silently.
    try {
      await client.query("RESET statement_timeout");
    } catch {
      // Same reasoning as the unlock: housekeeping must not mask a real
      // migration failure. A connection this cannot reset is already broken,
      // and the pool discards it on the next error.
    }

    client.release();
  }
}

/**
 * Entry point — and it runs on import, not only when this file is the process
 * being started. That is deliberate rather than overlooked: the suite drives
 * the whole script by importing it with `db` and `fs` mocked, which is what
 * lets it assert on the advisory lock and the per-file transactions.
 *
 * What NODE_ENV holds back is only the two effects that would reach past the
 * test: the failure exit code, and closing the shared pool. Anything importing
 * this module for `runMigrations` alone will still apply every pending
 * migration as a side effect of the import — which is why tests/setup.ts
 * imports the pieces from utils/migrations.ts rather than from here.
 */
const isTest = process.env.NODE_ENV === "test";

try {
  await runMigrations();
  console.log("All migrations applied.");
} catch (error) {
  console.error("Migration error:", error);

  // A failed migration used to leave the exit status at 0, so a deploy whose
  // migrations never applied still reported success.
  if (!isTest) {
    process.exitCode = 1;
  }
}

if (!isTest) {
  // Without this the idle pool holds the event loop open until its timeout.
  await db.end();
}
