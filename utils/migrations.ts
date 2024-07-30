import crypto from "crypto";
import fs from "fs";
import path from "path";
import logger from "./logger.ts";

/**
 * The parts of the migration runner that both callers need.
 *
 * migrate.ts is what a deploy runs; tests/setup.ts applies the same files to
 * the test database. They used to be two implementations of the same job, and
 * migrate.ts said otherwise — "Shared with tests/setup.ts, which applies the
 * same files to the test database" described an intent rather than the code.
 * The copy in the suite had drifted in ways that mattered: no transaction per
 * file, so a migration failing halfway left the schema half-applied under the
 * tests; no lifted statement timeout, so an index build on a grown test
 * database could be cancelled at fifteen seconds; and its own CREATE TABLE for
 * the bookkeeping table, which is exactly the kind of divergence
 * 0032_migrations_timestamp_with_time_zone.sql exists to repair.
 *
 * The directory is a parameter rather than derived here, so neither caller has
 * to reach through this module to say where its migrations are.
 */

/** Satisfied by a client checked out of the pool. */
export interface MigrationClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** What a run did, for the caller that has to report it. */
export interface MigrationRun {
  /** The files this run applied, in the order it applied them. */
  applied: string[];
  /**
   * Migrations the database has applied that are newer than every file this
   * build has: the database is ahead of the code, which is what a rollback
   * leaves. Empty otherwise. See verifyAppliedMigrations.
   */
  ahead: string[];
}

/**
 * Advisory lock held for a whole run, so two runners cannot apply the same
 * file at once.
 *
 * Shared with tests/setup.ts deliberately: on the rare occasion both run
 * against one database, the point is that they wait for each other rather
 * than interleave.
 */
export const MIGRATION_LOCK_KEY = 12345;

/**
 * What a migration file's content hashes to, as stored in "checksum".
 *
 * Not exported: this and the three readers below are the internals of the
 * two entry points at the bottom of this file. They were exported when the
 * suite reached for them directly, and nothing outside this module has
 * called one since — an export is a promise to keep a signature, and these
 * are free to change.
 */
function checksumOf(sql: string): string {
  // Line endings are not content. A checkout that rewrote LF to CRLF would
  // otherwise change every file's checksum and refuse to run; .gitattributes
  // pins the files to LF, and this makes the check hold even without it.
  return crypto
    .createHash("sha256")
    .update(sql.replace(/\r\n/g, "\n"))
    .digest("hex");
}

/**
 * Every migration in `dir`, in the order they must run.
 *
 * The order is the filename order, and that only means anything while every
 * name starts with the same width of zero-padded number: string sort puts
 * "10_x.sql" before "9_x.sql", so one unpadded file silently reorders the
 * run — after which the bookkeeping table records it as applied and the
 * mistake is permanent. Cheaper to refuse the name than to explain the
 * schema it produces, and this is the one place that decides the order.
 */
const MIGRATION_FILENAME = /^\d{4}_.+\.sql$/;

function readMigrationFiles(dir: string): string[] {
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (!MIGRATION_FILENAME.test(file)) {
      throw new Error(
        `Migration filename "${file}" does not start with a four-digit, ` +
          `zero-padded number (0001_name.sql). Migrations run in filename ` +
          `order, and an unpadded number sorts into the wrong place.`,
      );
    }
  }

  return files;
}

function readMigrationSql(dir: string, file: string): string {
  return fs.readFileSync(path.join(dir, file), "utf-8");
}

/**
 * Creates the bookkeeping table and makes sure it has somewhere to record a
 * checksum.
 *
 * The table is created here rather than by a file in migrations/, because it
 * is what tells the runner which of those files have run — which is also how
 * it came to be the one zoneless timestamp left in the schema, and why 0032
 * had to exist to bring an already-created database into line.
 *
 * The column is added with ALTER rather than by a numbered migration for the
 * same reason and to avoid that trap a second time: CREATE TABLE IF NOT
 * EXISTS does nothing to a database that already has the table, so a fresh
 * database would get the column and every existing one would not — and a
 * numbered migration cannot help, because the INSERT that records it names
 * the column before that migration has had a chance to run. ADD COLUMN IF
 * NOT EXISTS covers both, in the one place that owns this table.
 */
export async function ensureMigrationsTable(
  client: MigrationClient,
): Promise<void> {
  // TIMESTAMPTZ, like every column 0030 converted.
  await client.query(`
      CREATE TABLE IF NOT EXISTS "migrations" (
        "id" SERIAL PRIMARY KEY,
        "name" VARCHAR(255) NOT NULL UNIQUE,
        "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

  await client.query(`
      ALTER TABLE "migrations"
        ADD COLUMN IF NOT EXISTS "checksum" CHAR(64);
    `);
}

/**
 * What has run, and what it hashed to when it did.
 *
 * A null checksum is a row recorded before this column existed. It means
 * "unknown", not "mismatched" — see verifyAppliedMigrations.
 */
async function readAppliedMigrations(
  client: MigrationClient,
): Promise<Map<string, string | null>> {
  const { rows } = await client.query(
    'SELECT "name", "checksum" FROM "migrations"',
  );

  return new Map(rows.map((row) => [row.name as string, row.checksum ?? null]));
}

/**
 * Refuses to go on if a migration that has already run is not the file it was.
 *
 * The runner recorded nothing but a filename, so an applied migration could
 * be edited afterwards and no database would ever find out — every
 * environment would silently hold a different schema depending on when it
 * last ran. That is not hypothetical here: 0030 was edited after it had been
 * applied, and 0032 exists solely as the already-migrated database's copy of
 * the line that was added. A checksum is what turns that from a silent
 * divergence into a failed deploy.
 *
 * Only the *contents* of a row carrying a checksum are compared. Everything
 * applied before this column existed reads as unknown and is left alone, so
 * adding this breaks no database that already exists — including the one 0030
 * was edited on.
 *
 * A file that has gone missing is a different question and is reported
 * whatever the row holds. The null guard used to sit above that check, so an
 * applied migration whose file had been deleted went unreported for exactly
 * the databases where it matters most: the ones old enough to predate the
 * checksum column, which are the ones nobody has looked at in a while. "What
 * has run" is a question about names, and it is answerable with no checksum
 * at all.
 *
 * Missing is not the same as newer, though, and this used to treat the two
 * alike. An applied migration that sorts above every file this build has did
 * not go missing: it belongs to a *later* release, and the database is ahead
 * of the code. That is exactly what a rollback produces. `fly deploy --image
 * <previous tag>` runs the release command like any other deploy, so the
 * previous image's migrate.ts meets the migration the bad release applied —
 * and refusing it ("has been applied but is no longer in …", exit 1) made
 * every rollback past a migration impossible while protecting nothing:
 * expand/contract (see fly.toml) already means the release before a migration
 * runs against the schema after it, because it has to for the length of every
 * rolling restart. Those names are returned for the caller to report instead;
 * nothing about them is wrong.
 *
 * A name missing from *below* the newest file is still refused, and it is the
 * case this check was written for: a migration deleted or renamed out from
 * under a database that ran it. Its schema is still there, and a renamed copy
 * would run a second time. The message used to end "or clear its row if the
 * migration is genuinely gone", which is the one thing not to do: the row is
 * the only record that the schema holds what the file did, and a cleared row
 * is applied again the day the file comes back.
 *
 * Only a name this runner could have recorded counts as newer — one that
 * passes MIGRATION_FILENAME. A row somebody inserted by hand sorts above every
 * numbered file too, and reading it as "ahead" would turn that into a warning
 * on every boot rather than the mismatch it is. And a build with no
 * migrations at all is behind nothing: no release of this app has shipped an
 * empty migrations/, so there every applied name is simply missing.
 *
 * Throwing rather than warning is the point: a warning in a release command's
 * output is a warning nobody reads, and the whole cost of the original
 * problem was that nothing failed.
 */
function verifyAppliedMigrations(
  applied: Map<string, string | null>,
  dir: string,
  files: string[],
): string[] {
  const present = new Set(files);
  // readMigrationFiles sorts, so the last file is the newest this build has.
  const newest = files.at(-1);
  const problems: string[] = [];
  const ahead: string[] = [];

  for (const [name, checksum] of applied) {
    // Before the null guard, not after it: this one needs no checksum.
    if (!present.has(name)) {
      if (newest === undefined) {
        problems.push(
          `${name} has been applied, and ${dir} holds no migrations at all. ` +
            `This build is missing its migrations, not older than the database.`,
        );
      } else if (!MIGRATION_FILENAME.test(name)) {
        problems.push(
          `${name} is recorded as applied, but no migration file could have ` +
            `that name (0001_name.sql), so this runner did not write it. Find ` +
            `out what did before deciding what the row stands for.`,
        );
      } else if (name > newest) {
        // Compared with `>` on the raw names, the comparison readMigrationFiles
        // sorts by — the same reasoning as verifyMigrationOrder below.
        ahead.push(name);
      } else {
        problems.push(
          `${name} has been applied but is no longer in ${dir}, although ` +
            `${newest}, which sorts after it, still is. Restore the file under ` +
            `the same name: the schema it produced is still in this database, ` +
            `and a renamed copy would run a second time. Do not delete its row ` +
            `to get past this — that hides what it did rather than undoing it. ` +
            `A mistake is corrected by a new migration.`,
        );
      }

      continue;
    }

    if (checksum === null) continue;

    const actual = checksumOf(readMigrationSql(dir, name));

    if (actual !== checksum) {
      problems.push(
        `${name} has changed since it was applied ` +
          `(recorded ${checksum.slice(0, 12)}…, now ${actual.slice(0, 12)}…). ` +
          `An applied migration is history: put the change in a new file, or — ` +
          `if the edit is genuinely a no-op for every database that has run it — ` +
          `update the recorded checksum by hand.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Migration history does not match:\n- ${problems.join("\n- ")}`,
    );
  }

  return ahead.sort();
}

/**
 * What both callers say about a database that is ahead of this build.
 *
 * The same words from both, because it is the same state seen twice: by the
 * release command of a rollback (applyPendingMigrations) and by every machine
 * that then boots on the previous image (findPendingMigrations, from index.ts).
 * A warning rather than an error, since it is what a rollback is supposed to
 * leave — but not silence either. Anywhere but a rollback, a build older than
 * its database is worth finding out about.
 */
function aheadOfBuild(ahead: string[], files: string[]): string {
  return (
    `The database is ahead of this build: ${ahead.join(", ")} ` +
    `${ahead.length === 1 ? "has" : "have"} been applied, and the newest ` +
    `migration this build has is ${files.at(-1)}. That is what a rollback to ` +
    `an earlier image looks like. Nothing is applied and nothing is undone: ` +
    `the schema stays forward, and the release before a migration runs ` +
    `against it by design (expand, then contract — see fly.toml). Anywhere ` +
    `but a rollback, find out why this build is older than its database.`
  );
}

/** Postgres's SQLSTATE for a table that does not exist. */
const UNDEFINED_TABLE = "42P01";

/**
 * ...and for a column that does not.
 *
 * "checksum" is added by ensureMigrationsTable, which only runs inside
 * `npm run migrate` — so a database that has not been migrated since the
 * column was introduced has the table and not the column. That is exactly the
 * kind of database findPendingMigrations exists to report on, so selecting the
 * column must not be what stops it reporting.
 */
const UNDEFINED_COLUMN = "42703";

/**
 * The migration files `client`'s database has not applied yet, without
 * applying anything.
 *
 * Written for the check index.ts runs at boot rather than for the runner: the
 * only thing that ever applies migrations here is the release command in
 * fly.toml, so a deployment that is not Fly — and every `npm run dev` and
 * `npm start` on a developer's machine — could run indefinitely against a
 * schema the code no longer matches. Nothing said so. The app booted, the
 * health check answered "up", and the mismatch surfaced only as whatever
 * query happened to name the missing column, in error.log, hours later.
 *
 * That is not hypothetical: it is how a missing "rate_limits" table came to
 * disable every limiter on this site for ten minutes at a time — silently,
 * because all five pass `passOnStoreError` — and how Game.pruneRatingIps ran
 * against a "ratings" table with no "createdAt" on every boot.
 *
 * A database with no "migrations" table at all has applied nothing, which is
 * the loudest version of this rather than an error to report: it is what a
 * fresh install looks like before `npm run migrate` has ever run. Every other
 * failure is left to the caller — this cannot tell an unreachable database
 * from a stale one, and only the first is something the app is built to
 * survive.
 *
 * It also verifies the checksums of what *has* run, through the same
 * verifyAppliedMigrations the runner uses. A schema can be wrong in two ways
 * and this only ever caught one of them: a file that has not run yet, and a
 * file that ran and has since been edited. The second is the worse of the
 * pair — nothing is pending, so a deploy reports success, and every
 * environment quietly holds a different schema depending on when it last
 * migrated. That is not hypothetical; 0032 exists because 0030 was edited
 * after it had been applied.
 *
 * A database *ahead* of this build gets the reading the runner gives it: a
 * warning, and nothing pending. It is what every machine started on the
 * previous image looks like after a rollback, and it used to fall into the
 * catch below and be logged as a mismatch — an error at every boot, for the
 * state a rollback is supposed to leave.
 *
 * Logged rather than thrown, which is the one place this departs from the
 * runner. `npm run migrate` must refuse to go on; a booting process must not,
 * for the reason index.ts writes out in full at warnOnPendingMigrations — this
 * app is built to outlive a database it disagrees with, and a mismatched
 * checksum usually still serves the whole site. Throwing here would also be
 * reported by that caller as "could not check which migrations have been
 * applied", which is not what happened. The pending list is returned either
 * way, so the caller's contract is unchanged.
 *
 * The checksum column is read through readAppliedMigrations, and a database
 * old enough not to have it falls back to reading the names alone: the column
 * is added by ensureMigrationsTable, which only runs inside `npm run migrate`,
 * so on exactly the databases this check exists to catch it may not be there.
 * That case skips the checksum verification and nothing else — which files
 * have run is a question about names, and it is still answered.
 */
export async function findPendingMigrations(
  client: MigrationClient,
  dir: string,
): Promise<string[]> {
  const files = readMigrationFiles(dir);

  let applied: Map<string, string | null>;

  try {
    applied = await readAppliedMigrations(client);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;

    // Nothing applied at all — a fresh install. Every file is pending, and
    // there is nothing to verify.
    if (code === UNDEFINED_TABLE) return files;

    if (code !== UNDEFINED_COLUMN) throw error;

    // The table without the column. The names still answer "what is pending";
    // a null checksum reads as "unknown" to verifyAppliedMigrations, so the
    // contents check below simply finds nothing to compare and the whole of
    // what this loses is the half that was never recorded.
    const { rows } = await client.query('SELECT "name" FROM "migrations"');

    applied = new Map(rows.map((row) => [row.name as string, null]));
  }

  try {
    const ahead = verifyAppliedMigrations(applied, dir, files);

    if (ahead.length > 0) logger.warn(aheadOfBuild(ahead, files));
  } catch (error) {
    // The message carries the file names and both checksums; nothing is
    // gained by wrapping it.
    logger.error(
      `Applied migrations do not match the files in ${dir}:`,
      error,
    );
  }

  return files.filter((file) => !applied.has(file));
}

/**
 * Refuses to go on if a pending file sorts below something already applied.
 *
 * "Pending" was decided by name alone — anything not in the bookkeeping table
 * ran — so the order this file is so careful to establish only held for a
 * directory nobody ever added to twice. Two branches each adding a migration
 * merge as 0042 and 0042, one of them gets renumbered to 0043, and whichever
 * database ran the first 0042 before the rename now runs a file that sorts
 * *below* it. The same thing happens to anyone who rebases a migration under
 * a number a colleague has already deployed.
 *
 * What makes that worth failing on rather than shrugging at is that it is
 * unrecoverable in exactly the way MIGRATION_FILENAME's comment describes:
 * the out-of-order file runs, is recorded as applied, and the schema it
 * produced is now one no other database will ever reproduce — because every
 * database that has not run it yet will run it *in* order. There is no second
 * run that fixes it.
 *
 * The same loud stance verifyAppliedMigrations takes, and for the same
 * reason: this is a class of problem whose whole cost is that nothing failed.
 * The fix is a human one — renumber the file above the greatest applied name
 * — so the message names the file and what it sorts behind rather than trying
 * to guess.
 *
 * Compared with `<` on the raw names, which is the comparison
 * readMigrationFiles's own `.sort()` uses; a different one here would answer a
 * question about an order this is not describing.
 */
function verifyMigrationOrder(
  applied: Map<string, string | null>,
  pending: string[],
): void {
  let greatestApplied = "";

  for (const name of applied.keys()) {
    if (name > greatestApplied) greatestApplied = name;
  }

  const outOfOrder = pending.filter((file) => file < greatestApplied);

  if (outOfOrder.length === 0) return;

  throw new Error(
    `Migration order does not match: ${outOfOrder.join(", ")} ` +
      `${outOfOrder.length === 1 ? "has" : "have"} not been applied, but ` +
      `${outOfOrder.length === 1 ? "sorts" : "sort"} before ` +
      `${greatestApplied}, which has. Migrations run in filename order and ` +
      `are recorded as they run, so applying one out of order produces a ` +
      `schema no other database will reach. Renumber it above ` +
      `${greatestApplied}.`,
  );
}

/**
 * The first line that takes a migration out of its transaction.
 *
 * Every file runs inside BEGIN … COMMIT, which is what keeps a failure from
 * committing half of one — and which makes CREATE INDEX CONCURRENTLY
 * impossible, because Postgres refuses it inside a transaction block. So the
 * next index on a table that keeps growing ("plays", "ratings") could only be
 * a plain CREATE INDEX, which holds a SHARE lock on the table for the whole
 * build: every vote and every play INSERT waits until it is done.
 * DDL_LOCK_TIMEOUT in migrate.ts is no help there — it bounds the wait *for* a
 * lock, not how long one is held.
 *
 * The first line and nowhere else, so that opting out is something a file
 * announces at the top rather than a comment that happens to contain the
 * words. What such a file may hold is planMigration's to enforce; how to write
 * one safely is in the README ("Migrations outside a transaction").
 */
const NO_TRANSACTION_MARKER = "-- migrate:no-transaction";

/**
 * How long a concurrent build may wait for the transactions ahead of it.
 *
 * CREATE INDEX CONCURRENTLY waits, twice, for every transaction that could
 * still see the table without the index, and lock_timeout covers those waits
 * — which is not obvious, because what it waits on is the other transactions'
 * ids rather than the table. Cut short, the build does not roll back: it
 * leaves its index behind, marked INVALID (see invalidIndexError). Verified
 * against Postgres 18: with lock_timeout at one second and another session
 * holding a snapshot, the build failed with 55P03 and the index stayed.
 *
 * So it does not wait under DDL_LOCK_TIMEOUT, migrate.ts's five seconds. That
 * bound exists because a waiting ALTER TABLE queues every later query on its
 * table behind it; a concurrent build's lock (SHARE UPDATE EXCLUSIVE)
 * conflicts with no read and no write, so its waiting holds nobody up, and
 * cutting it short only buys an INVALID index and a failed deploy. A minute is
 * four times the longest a page view's statement may run (statement_timeout,
 * fifteen seconds, in db.ts): every ordinary transaction is outlasted, and
 * what is left — a session sitting idle in a transaction — fails the deploy
 * well inside release_command_timeout in fly.toml.
 *
 * Only for a statement that says CONCURRENTLY. Anything else run outside a
 * transaction keeps the caller's bound, so the marker put on a plain ALTER
 * TABLE by mistake still gives up in seconds rather than stall the site for a
 * minute.
 */
export const CONCURRENT_LOCK_TIMEOUT = "1min";

/** What may continue an unquoted identifier, "$" included. */
const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

/** $$ or $tag$, read at one position (sticky). */
const DOLLAR_QUOTE = /\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/uy;

/**
 * The statements in `sql`, with every comment, string constant, quoted
 * identifier and dollar-quoted body blanked out.
 *
 * Not a parser, and it does not need to be one: the only questions asked of
 * it are how many statements a file holds and whether one says CONCURRENTLY,
 * and both are answered at the lexical level. A semicolon ends a statement
 * everywhere except inside those four constructs, so they are all that has to
 * be recognised — a partial index's WHERE "note" <> 'a;b', a comment with a
 * semicolon in it, a function body between $$ and $$. Strings are read the
 * way standard_conforming_strings (on by default since 9.1) reads them: a
 * backslash is an ordinary character except inside E'…'.
 */
function statementsIn(sql: string): string[] {
  const isIdentifierChar = (char: string | undefined): boolean =>
    char !== undefined && IDENTIFIER_CHAR.test(char);

  let code = "";
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];

    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);

      i = end === -1 ? sql.length : end;
      code += " ";
    } else if (sql.startsWith("/*", i)) {
      // Nested, unlike C: /* a /* b */ c */ is one comment in Postgres.
      let depth = 0;

      do {
        if (sql.startsWith("/*", i)) {
          depth += 1;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      } while (depth > 0 && i < sql.length);

      code += " ";
    } else if (char === "'" || char === '"') {
      // A doubled quote is the quote itself, in a string and in an
      // identifier alike. A backslash escapes only in an E'…' string, and
      // only when the E is a prefix rather than the end of a word:
      // DATE'2020-01-01' is an ordinary string.
      const escapes =
        char === "'" &&
        (sql[i - 1] === "E" || sql[i - 1] === "e") &&
        !isIdentifierChar(sql[i - 2]);

      i += 1;

      while (i < sql.length) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === char && sql[i + 1] === char) i += 2;
        else if (sql[i] === char) break;
        else i += 1;
      }

      i += 1;
      code += " ";
    } else if (char === "$" && !isIdentifierChar(sql[i - 1])) {
      // $$ or $tag$, where a tag cannot start with a digit — which is what
      // keeps a parameter like $1 from reading as one — and only where the
      // "$" cannot be the middle of a word, since identifiers may contain it.
      DOLLAR_QUOTE.lastIndex = i;
      const opener = DOLLAR_QUOTE.exec(sql)?.[0];

      if (opener === undefined) {
        code += char;
        i += 1;
      } else {
        const close = sql.indexOf(opener, i + opener.length);

        i = close === -1 ? sql.length : close + opener.length;
        code += " ";
      }
    } else {
      code += char;
      i += 1;
    }
  }

  return code
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

/** A pending file, read and checked, ready to apply. */
interface PlannedMigration {
  file: string;
  sql: string;
  checksum: string;
  /** False for a file whose first line is NO_TRANSACTION_MARKER. */
  inTransaction: boolean;
  /** Whether its one statement says CONCURRENTLY; see CONCURRENT_LOCK_TIMEOUT. */
  concurrent: boolean;
}

/**
 * Reads what a pending file asks for, and refuses what it may not ask.
 *
 * A file outside a transaction must be exactly one statement, and that is a
 * rule about Postgres rather than taste. Several statements sent as one query
 * run as one *implicit* transaction — where CREATE INDEX CONCURRENTLY is
 * refused with the same "cannot run inside a transaction block" that BEGIN
 * gets it — and a file with no transaction around it has nothing to roll a
 * half-applied run back to: a COMMIT in the middle, say, leaves the first half
 * committed and the second failed. One statement is either done or not.
 *
 * Called for every pending file before the first of them runs, so a
 * malformed one late in the list leaves the schema where it was found — the
 * stance verifyMigrationOrder takes, for the same reason.
 */
function planMigration(file: string, sql: string): PlannedMigration {
  const lines = sql.split(/\r?\n/);
  const inTransaction = lines[0]?.trim() !== NO_TRANSACTION_MARKER;
  const misplaced = lines.findIndex(
    (line, index) => index > 0 && line.trim() === NO_TRANSACTION_MARKER,
  );

  // Refused rather than ignored: a marker below the first line reads as an
  // opt-out to whoever wrote it, and would run the file inside a
  // transaction anyway.
  if (misplaced !== -1) {
    throw new Error(
      `${file} has "${NO_TRANSACTION_MARKER}" on line ${misplaced + 1}. It ` +
        `only means anything as the first line; anywhere else it is an ` +
        `ordinary comment, and the file would run inside a transaction. Move ` +
        `it to the top, or remove it.`,
    );
  }

  const planned = {
    file,
    sql,
    checksum: checksumOf(sql),
    inTransaction,
    concurrent: false,
  };

  if (inTransaction) return planned;

  const statements = statementsIn(sql);

  if (statements.length !== 1) {
    throw new Error(
      `${file} is marked "${NO_TRANSACTION_MARKER}" and holds ` +
        `${statements.length === 0 ? "no statement" : `${statements.length} statements`}. ` +
        `A file run outside a transaction must be exactly one statement: ` +
        `Postgres runs several sent together as one implicit transaction, ` +
        `where CREATE INDEX CONCURRENTLY is refused just as it is after ` +
        `BEGIN, and with no transaction around the file a failure partway ` +
        `has nothing to roll back to. Put each statement in a file of its own.`,
    );
  }

  return { ...planned, concurrent: /\bCONCURRENTLY\b/i.test(statements[0]) };
}

/** The file, its row and nothing else, or none of it. */
async function applyInTransaction(
  client: MigrationClient,
  { file, sql, checksum }: PlannedMigration,
): Promise<void> {
  await client.query("BEGIN");
  try {
    // Every file runs under UTC, whatever the server's default is. A
    // migration that converts a timestamp column — 0030 and 0032 both do —
    // reads the session time zone, and 0032 was only correct because
    // 0030's own "SET TIME ZONE" happened to persist on the same client. A
    // run interrupted between the two and resumed on a Postgres whose
    // default is not UTC would have shifted every value. LOCAL, so it ends
    // with the transaction and leaks into nothing.
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query(sql);
    await client.query(
      'INSERT INTO "migrations" ("name", "checksum") VALUES ($1, $2)',
      [file, checksum],
    );
    await client.query("COMMIT");
  } catch (error) {
    // Guarded: if the connection itself died, the ROLLBACK fails too, and
    // its error would replace the migration's — the one worth reading.
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * Every INVALID index in the schemas this session can see, as names ready to
 * put in a DROP.
 *
 * The whole search path rather than the file's own index, because finding
 * that one would mean parsing its name out of the statement — and an INVALID
 * index anywhere there is a failed concurrent build nobody has cleaned up,
 * which is worth stopping for whoever left it. That includes one another
 * session is building at this very moment, which reads the same way until it
 * finishes: rare, and a failed deploy that names it is the cheap side of that
 * mistake.
 */
async function findInvalidIndexes(client: MigrationClient): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT format('%I.%I', n.nspname, c.relname) AS "index"
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT i.indisvalid
        AND n.nspname = ANY (current_schemas(false))
      ORDER BY 1`,
  );

  return rows.map((row) => String(row.index));
}

/**
 * Why a file that ran outside a transaction is not being recorded.
 *
 * Postgres keeps the index a failed concurrent build was making, marked
 * INVALID — no query uses it, every write still maintains it — and IF NOT
 * EXISTS counts it as existing. So the obvious next step, running the file
 * again, "succeeds" over the broken index and records the migration as done;
 * verified against Postgres 18. migrate.ts retries a lock timeout by itself,
 * which is that next step taken with nobody looking. Both are refused: no row
 * while an INVALID index is there, and a failure that has left one is thrown
 * without the lock error's code, so it is not retried into the same trap.
 */
function invalidIndexError(
  file: string,
  invalid: string[],
  cause?: unknown,
): Error {
  const what =
    cause === undefined
      ? `${file} ran, but ${invalid.join(", ")} ` +
        `${invalid.length === 1 ? "is" : "are"} INVALID — most likely left ` +
        `by an earlier run that failed, which IF NOT EXISTS then skipped over.`
      : `${file} failed outside a transaction` +
        `${cause instanceof Error ? ` (${cause.message})` : ""} and left ` +
        `${invalid.join(", ")} behind, INVALID.`;

  return new Error(
    `${what} A concurrent build that fails keeps its half-built index: no ` +
      `query uses it, every write still pays for it, and IF NOT EXISTS ` +
      `counts it as done. Drop ${invalid.length === 1 ? "it" : "them"} ` +
      `(${invalid.map((name) => `DROP INDEX CONCURRENTLY IF EXISTS ${name};`).join(" ")}), ` +
      `deal with what made the build fail, and deploy again. Nothing has ` +
      `been recorded for ${file}.`,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Runs a NO_TRANSACTION_MARKER file, and records it only once it has worked.
 *
 * There is no transaction to put the INSERT in, so the order is the
 * guarantee: the statement, then the INVALID-index check, then the row. A run
 * that dies anywhere before the row — the connection dropped, the release
 * command killed — leaves the file pending and the next run runs it again,
 * which is why the README asks for IF NOT EXISTS: it makes the second run of a
 * build that did finish a no-op.
 *
 * The session is set up by hand for the length of the statement and put back
 * afterwards: the UTC every file runs under, which SET LOCAL cannot give a
 * statement with no transaction around it, and a concurrent build's own
 * lock_timeout. Put back rather than RESET, because what was there is the
 * caller's — DDL_LOCK_TIMEOUT, under migrate.ts — and RESET would restore the
 * server default, no bound at all, for every file after this one.
 */
async function applyOutsideTransaction(
  client: MigrationClient,
  { file, sql, checksum, concurrent }: PlannedMigration,
): Promise<void> {
  const { rows } = await client.query(
    `SELECT current_setting('TimeZone') AS "timeZone",
            current_setting('lock_timeout') AS "lockTimeout"`,
  );
  const before = rows[0] as { timeZone: string; lockTimeout: string };

  await client.query(
    "SELECT set_config('TimeZone', 'UTC', false), set_config('lock_timeout', $1, false)",
    [concurrent ? CONCURRENT_LOCK_TIMEOUT : before.lockTimeout],
  );

  try {
    await client.query(sql);
  } catch (error) {
    // Asked on the way out, because a concurrent build that fails does not
    // roll back. If even this cannot be asked, the connection has gone and
    // the statement's own error is the one worth reading.
    const invalid = await findInvalidIndexes(client).catch(
      (): string[] => [],
    );

    if (invalid.length > 0) throw invalidIndexError(file, invalid, error);

    // Nothing left behind — a lock wait that gave up before the build began,
    // say — so the error goes out as it came, code and all, and a lock
    // timeout is retried like any other.
    throw error;
  } finally {
    // Guarded for the same reason as the ROLLBACK above.
    await client
      .query(
        "SELECT set_config('TimeZone', $1, false), set_config('lock_timeout', $2, false)",
        [before.timeZone, before.lockTimeout],
      )
      .catch(() => {});
  }

  const invalid = await findInvalidIndexes(client);

  if (invalid.length > 0) throw invalidIndexError(file, invalid);

  await client.query(
    'INSERT INTO "migrations" ("name", "checksum") VALUES ($1, $2)',
    [file, checksum],
  );
}

/**
 * Applies every migration the database has not seen yet, in filename order,
 * each one inside its own transaction — or, for a file whose first line is
 * NO_TRANSACTION_MARKER, as its one statement on its own.
 *
 * The transaction per file is what keeps a failure from committing half a
 * migration; the caller is expected to be holding MIGRATION_LOCK_KEY so that
 * two runners cannot both read the same "not yet applied" list.
 *
 * Returns what it applied and whether the database was ahead of this build,
 * for the caller to report. A database that is ahead has nothing to apply by
 * construction: every file here sorts below what it has run, so anything still
 * pending has already been refused by verifyMigrationOrder.
 */
export async function applyPendingMigrations(
  client: MigrationClient,
  dir: string,
): Promise<MigrationRun> {
  const applied = await readAppliedMigrations(client);
  const files = readMigrationFiles(dir);

  // Before anything is applied: a run that is about to add 0033 should still
  // stop if 0031 is not the file it claims to be.
  const ahead = verifyAppliedMigrations(applied, dir, files);

  const pending = files.filter((file) => !applied.has(file));

  // ...and should stop if what it is about to add is numbered below 0031 in
  // the first place. Also before anything runs, so the refusal leaves the
  // schema where it found it.
  verifyMigrationOrder(applied, pending);

  // ...and should stop if one of them is a file outside a transaction that
  // may not run as one. Every pending file is read and checked here, before
  // the first of them runs, for the same reason.
  const planned = pending.map((file) =>
    planMigration(file, readMigrationSql(dir, file)),
  );

  if (ahead.length > 0) logger.warn(aheadOfBuild(ahead, files));

  for (const migration of planned) {
    if (migration.inTransaction) {
      logger.info(`Applying migration: ${migration.file}`);
      await applyInTransaction(client, migration);
    } else {
      logger.info(
        `Applying migration: ${migration.file} (outside a transaction)`,
      );
      await applyOutsideTransaction(client, migration);
    }
  }

  return { applied: pending, ahead };
}
