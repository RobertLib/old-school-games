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
 * Only rows carrying a checksum are checked. Everything applied before this
 * column existed reads as unknown and is left alone, so adding this breaks no
 * database that already exists — including the one 0030 was edited on.
 *
 * Throwing rather than warning is the point: a warning in a release command's
 * output is a warning nobody reads, and the whole cost of the original
 * problem was that nothing failed.
 */
function verifyAppliedMigrations(
  applied: Map<string, string | null>,
  dir: string,
  files: string[],
): void {
  const present = new Set(files);
  const problems: string[] = [];

  for (const [name, checksum] of applied) {
    if (checksum === null) continue;

    if (!present.has(name)) {
      problems.push(
        `${name} has been applied but is no longer in ${dir}. ` +
          `Restore the file, or clear its row if the migration is genuinely gone.`,
      );
      continue;
    }

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
}

/** Postgres's SQLSTATE for a table that does not exist. */
const UNDEFINED_TABLE = "42P01";

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
 * The names are read with a query of this function's own rather than through
 * readAppliedMigrations, which also selects "checksum". That column is added
 * by ensureMigrationsTable, which only runs inside `npm run migrate` — so on
 * exactly the databases this check exists to catch, the ones that have not
 * been migrated lately, selecting it fails with "column does not exist" and
 * the check reports that instead of the pending files it was asked for. It
 * has no use for a checksum either way: which files have run is a question
 * about names, and verifyAppliedMigrations is what compares contents.
 */
export async function findPendingMigrations(
  client: MigrationClient,
  dir: string,
): Promise<string[]> {
  let applied: Set<string>;

  try {
    const { rows } = await client.query('SELECT "name" FROM "migrations"');

    applied = new Set(rows.map((row) => row.name as string));
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== UNDEFINED_TABLE) throw error;

    applied = new Set();
  }

  return readMigrationFiles(dir).filter((file) => !applied.has(file));
}

/**
 * Applies every migration the database has not seen yet, in filename order,
 * each one inside its own transaction.
 *
 * The transaction per file is what keeps a failure from committing half a
 * migration; the caller is expected to be holding MIGRATION_LOCK_KEY so that
 * two runners cannot both read the same "not yet applied" list.
 */
export async function applyPendingMigrations(
  client: MigrationClient,
  dir: string,
): Promise<void> {
  const applied = await readAppliedMigrations(client);
  const files = readMigrationFiles(dir);

  // Before anything is applied: a run that is about to add 0033 should still
  // stop if 0031 is not the file it claims to be.
  verifyAppliedMigrations(applied, dir, files);

  for (const file of files) {
    if (applied.has(file)) continue;

    logger.info(`Applying migration: ${file}`);

    const migrationSQL = readMigrationSql(dir, file);

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
      await client.query(migrationSQL);
      await client.query(
        'INSERT INTO "migrations" ("name", "checksum") VALUES ($1, $2)',
        [file, checksumOf(migrationSQL)],
      );
      await client.query("COMMIT");
    } catch (error) {
      // Guarded: if the connection itself died, the ROLLBACK fails too, and
      // its error would replace the migration's — the one worth reading.
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  }
}
