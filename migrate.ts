import { fileURLToPath } from "url";
import path from "path";
import db from "./db.ts";
import logger from "./utils/logger.ts";
import {
  MIGRATION_LOCK_KEY,
  applyPendingMigrations,
  ensureMigrationsTable,
  type MigrationRun,
} from "./utils/migrations.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * How long one migration statement may wait for a table lock once the
 * advisory lock is held, and how many times a file is tried before the deploy
 * gives up.
 *
 * Seconds, where the wait for the advisory lock below is minutes, because the
 * two waits cost different people. Waiting for the advisory lock holds up only
 * this deploy. Waiting for a *table* lock holds up the site: Postgres queues
 * every later lock request on that table behind the one waiting, so an ALTER
 * TABLE stuck behind an idle-in-transaction session — an open psql, a
 * dashboard — stalls every page that reads "games" for as long as it waits,
 * and each of those queries dies at its own 15-second statement_timeout. With
 * the five minutes the advisory lock gets, that was up to five minutes of
 * failing pages, followed by a failed deploy anyway.
 *
 * Retried, because the common blocker is an ordinary query that finishes: a
 * refused attempt rolls its file back (each runs in its own transaction), lets
 * the queue behind it drain, and tries again. What is still holding the lock
 * after three tries is not going to let go, and the deploy fails loudly with
 * the lock error in the log — the old release keeps serving.
 *
 * A concurrent build is the one exception: a file that opts out of its
 * transaction to run CREATE INDEX CONCURRENTLY waits CONCURRENT_LOCK_TIMEOUT
 * instead (see utils/migrations.ts). Its lock conflicts with no page view, so
 * its waiting stalls nothing, and cut off at five seconds it would not roll
 * back — it leaves an INVALID index behind. Nor is it rolled back before a
 * retry, having no transaction: its lock error only reaches the loop below
 * with its code when it left nothing behind, so a retry never meets the
 * INVALID index that IF NOT EXISTS would skip over.
 */
const DDL_LOCK_TIMEOUT = "5s";
const DDL_LOCK_ATTEMPTS = 3;
const DDL_RETRY_DELAY_MS = 2_000;

/**
 * How long this run waits for another one's advisory lock. See the comment
 * where it is set, in runMigrations, and release_command_timeout in fly.toml,
 * which has to leave room above it.
 */
const ADVISORY_LOCK_TIMEOUT = "5min";

/** Postgres SQLSTATE 55P03, lock_not_available — what lock_timeout raises. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * applyPendingMigrations, again after a lock timeout. Picking up where the
 * refused attempt stopped needs nothing of its own: the files already applied
 * are recorded, and the one that was refused was rolled back — or, run
 * outside a transaction, left nothing behind, which is the only way its lock
 * error arrives here still carrying its code.
 */
async function applyWithLockRetries(
  client: Parameters<typeof applyPendingMigrations>[0],
  dir: string,
): Promise<MigrationRun> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await applyPendingMigrations(client, dir);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;

      if (code !== LOCK_NOT_AVAILABLE || attempt >= DDL_LOCK_ATTEMPTS) {
        throw error;
      }

      logger.warn(
        `A migration waited ${DDL_LOCK_TIMEOUT} for a table lock and gave up; ` +
          `retrying (attempt ${attempt + 1} of ${DDL_LOCK_ATTEMPTS}).`,
      );

      await new Promise((resolve) => setTimeout(resolve, DDL_RETRY_DELAY_MS));
    }
  }
}

/**
 * Applies every migration the database has not seen yet, in filename order,
 * each one inside its own transaction unless the file opts out of it (see
 * utils/migrations.ts). Throws on the first failure so the caller can decide
 * what a failed migration means.
 *
 * Returns what the run did, and that includes the one outcome that is
 * neither: a database *ahead* of this build, which is what the release
 * command of a rollback finds. Nothing is applied then, and nothing is wrong.
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
export async function runMigrations(): Promise<MigrationRun> {
  const client = await db.connect();

  try {
    // The pool caps every statement at a page view's worth of time (see
    // db.ts). A migration is not a page view — adding an index to a grown
    // table can legitimately run for minutes — and being cancelled halfway
    // would fail the deploy for no reason. Lifted for this session only;
    // what bounds the run as a whole is release_command_timeout in fly.toml.
    //
    // Before the lock, not after: waiting for another deploy to finish is
    // itself a statement, and the 15-second cap would have cancelled it.
    await client.query("SET statement_timeout = 0");

    // The one thing the lift above must not also remove: a bound on *waiting*.
    //
    // With statement_timeout at 0 nothing ever gives up, and the two places
    // this run waits are both places it can wait forever. The advisory lock
    // below waits for any other runner holding it — a previous release
    // command that died with its connection still open, or a `npm run
    // migrate` somebody left at a prompt — and every DDL statement in a
    // migration waits for the locks it needs on the table it alters, which an
    // ordinary long-running query or an idle-in-transaction session can hold
    // indefinitely. Fly runs migrations as the release_command, so either one
    // hung the deploy with no output at all until the platform killed the
    // command at its release_command_timeout: a log whose last line is the
    // migration before the stuck one, and nothing anywhere saying why. With a
    // bound here the same wait ends in a lock error that does say.
    //
    // lock_timeout bounds only the waiting, never the work — an index build
    // that legitimately takes minutes is unaffected, because it is not
    // waiting on a lock — so it can be set alongside the lift rather than
    // instead of it. It covers pg_advisory_lock too, which is not obvious:
    // advisory locks go through the same lock manager as table locks, and a
    // wait for one is cancelled by this exactly as a wait for an ALTER TABLE
    // is. Verified against Postgres 17.
    //
    // Five minutes rather than seconds, because the wait this is most likely
    // to meet is a legitimate one: two deploys in a row, where the second's
    // release command really should wait for the first's migrations to
    // finish. It is a ceiling on hanging forever, not a race to fail.
    //
    // And it has to fit inside the platform's own ceiling on the whole run,
    // release_command_timeout in fly.toml, with room to spare. That used to be
    // left at Fly's default, which is also five minutes: a release command
    // that waited out another deploy was killed the moment it got the lock,
    // with every one of its own migrations still to run, and an index build
    // had the same five minutes as everything else. Fifteen now, and
    // tests/deploy-config.test.ts keeps the two apart.
    await client.query(`SET lock_timeout = '${ADVISORY_LOCK_TIMEOUT}'`);

    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    // And then down to seconds for everything after it. The five minutes
    // above are for the wait on another deploy; the same setting used to
    // cover every DDL statement's wait for its table lock too, which is a
    // wait the whole site queues behind. See DDL_LOCK_TIMEOUT.
    await client.query(`SET lock_timeout = '${DDL_LOCK_TIMEOUT}'`);

    await ensureMigrationsTable(client);

    return await applyWithLockRetries(
      client,
      path.join(__dirname, "migrations"),
    );
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

    // Put the session back as it was found before the connection is reused.
    // release() does not reset session state, and db.ts applies
    // statement_timeout only as a connection parameter at connect time — so
    // the lift above would have outlived this function on that pooled
    // client, leaving one connection in the pool willing to run a page
    // view's query forever. Nothing hits that today (migrate.ts ends with
    // db.end()), but runMigrations is exported, and an in-process caller
    // would poison the pool silently.
    //
    // RESET ALL rather than naming statement_timeout, because the timeout
    // was not the only thing left behind. 0030 sets the time zone at session
    // level, and that outlived the run too: one connection in the pool would
    // then interpret every timestamp the app wrote or read under UTC rather
    // than the server default, depending entirely on which client a request
    // happened to be handed. Nothing a migration sets is worth keeping, and
    // listing the settings by hand is how this one came to be missed.
    try {
      await client.query("RESET ALL");
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
  const { ahead } = await runMigrations();

  // Not "All migrations applied." for a database ahead of this build. That
  // line is what a release command's log is read for, and after a rollback it
  // would say the opposite of what happened: nothing was applied, and the
  // warning just before this says why that is fine.
  logger.info(
    ahead.length > 0
      ? "Nothing to apply: the database is ahead of this build."
      : "All migrations applied.",
  );
} catch (error) {
  logger.error("Migration error:", error);

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
