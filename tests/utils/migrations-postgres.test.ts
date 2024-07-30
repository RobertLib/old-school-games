import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { PoolClient } from "pg";
import db from "../../db.ts";
import {
  applyPendingMigrations,
  ensureMigrationsTable,
} from "../../utils/migrations.ts";

/**
 * The runner against a real Postgres, where a fake client cannot follow.
 *
 * tests/utils/migrations.test.ts drives utils/migrations.ts with a scripted
 * client, which is the only way to reach most of its refusals — and it can
 * only ever say what the runner *asked*. What it cannot say is what Postgres
 * does with that: that CREATE INDEX CONCURRENTLY really is refused inside a
 * transaction, that a failed one really does leave its index behind INVALID,
 * and that IF NOT EXISTS really does wave the next run through over it. Those
 * three are the whole reason the file-outside-a-transaction path is shaped
 * the way it is, so they are checked here against the server itself.
 *
 * Each case gets a schema of its own, and the session's search_path points
 * at it, so the bookkeeping table and every table a case creates land there
 * and nowhere else. The test database's own "migrations" table — the one
 * tests/setup.ts keeps — is never read or written.
 */
const SCHEMA = `migrations_runner_${process.pid}`;
const MARKER = "-- migrate:no-transaction";

let client: PoolClient;
let dir: string;

function writeMigration(name: string, sql: string): void {
  fs.writeFileSync(path.join(dir, name), sql);
}

/**
 * Every index on the case's table "t", and whether Postgres will use it. The
 * bookkeeping table's own two are left out: they are not what is under test.
 */
async function indexes(): Promise<Record<string, boolean>> {
  const { rows } = await client.query(
    `SELECT c.relname AS "name", i.indisvalid AS "valid"
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = 't'`,
    [SCHEMA],
  );

  return Object.fromEntries(rows.map((row) => [row.name, row.valid]));
}

async function recorded(): Promise<string[]> {
  const { rows } = await client.query(
    'SELECT "name" FROM "migrations" ORDER BY "name"',
  );

  return rows.map((row) => row.name);
}

/** Three values of "v" for a hundred rows, so a UNIQUE build on it fails. */
const TABLE =
  'CREATE TABLE "t" ("id" int, "v" int);\n' +
  'INSERT INTO "t" SELECT g, g % 3 FROM generate_series(1, 100) g;\n';

describe("the migration runner against Postgres", () => {
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "osg-migrations-pg-"));
    client = await db.connect();

    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${SCHEMA}"`);
    await client.query(`SET search_path = "${SCHEMA}"`);
    // The bound migrate.ts leaves on the session, so the runner's own one for
    // a concurrent build has something to be put back over.
    await client.query("SET lock_timeout = '5s'");
    await ensureMigrationsTable(client);
  });

  afterEach(async () => {
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      // A pooled connection: whatever a case set goes before it is reused.
      await client.query("RESET ALL");
    } finally {
      client.release();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The reason the marker exists at all.
  it("is refused a concurrent build inside a transaction", async () => {
    writeMigration("0001_table.sql", TABLE);
    writeMigration(
      "0002_index.sql",
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "t_v_idx" ON "t" ("v");\n',
    );

    await expect(applyPendingMigrations(client, dir)).rejects.toThrow(
      /cannot run inside a transaction block/,
    );

    expect(await recorded()).toEqual(["0001_table.sql"]);
  });

  it("builds an index concurrently outside one, and then records it", async () => {
    writeMigration("0001_table.sql", TABLE);
    writeMigration(
      "0002_index.sql",
      `${MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "t_v_idx" ON "t" ("v");\n`,
    );

    const session = async () =>
      (
        await client.query(
          `SELECT current_setting('lock_timeout') AS "lockTimeout",
                  current_setting('TimeZone') AS "timeZone"`,
        )
      ).rows[0];

    const before = await session();

    await expect(applyPendingMigrations(client, dir)).resolves.toEqual({
      applied: ["0001_table.sql", "0002_index.sql"],
      ahead: [],
    });

    expect(await indexes()).toEqual({ t_v_idx: true });
    expect(await recorded()).toEqual(["0001_table.sql", "0002_index.sql"]);

    // The session is as the case left it, not as the build needed it: the
    // caller's lock bound, and the server's zone rather than the UTC the
    // file ran under.
    expect(await session()).toEqual(before);
    expect(before.lockTimeout).toBe("5s");
  });

  /**
   * The trap, end to end. A concurrent build that fails keeps its index,
   * INVALID; the obvious next step is to fix the data and run the file again,
   * and IF NOT EXISTS then "succeeds" over the broken index. Recording that
   * would leave a unique index that enforces nothing and that no query uses,
   * marked as applied, on every database that went through it.
   */
  it("records nothing while a failed build's INVALID index is there", async () => {
    writeMigration("0001_table.sql", TABLE);
    writeMigration(
      "0002_unique.sql",
      `${MARKER}\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "t_v_key" ON "t" ("v");\n`,
    );

    const failure = (await applyPendingMigrations(client, dir).catch(
      (error: unknown) => error,
    )) as Error & { code?: string };

    expect(failure.message).toContain(
      `0002_unique.sql failed outside a transaction (could not create unique index "t_v_key") and left ${SCHEMA}.t_v_key behind, INVALID.`,
    );
    // Not a lock error, not a unique violation: nothing a retry could fix.
    expect(failure.code).toBeUndefined();
    expect(await indexes()).toEqual({ t_v_key: false });
    expect(await recorded()).toEqual(["0001_table.sql"]);

    // The data fixed, the file run again: Postgres skips the build...
    await client.query('DELETE FROM "t" WHERE "id" > 3');

    await expect(applyPendingMigrations(client, dir)).rejects.toThrow(
      `0002_unique.sql ran, but ${SCHEMA}.t_v_key is INVALID`,
    );
    expect(await indexes()).toEqual({ t_v_key: false });
    expect(await recorded()).toEqual(["0001_table.sql"]);

    // ...and the recovery the message names is all it takes.
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${SCHEMA}.t_v_key`);

    await expect(applyPendingMigrations(client, dir)).resolves.toEqual({
      applied: ["0002_unique.sql"],
      ahead: [],
    });
    expect(await indexes()).toEqual({ t_v_key: true });
    expect(await recorded()).toEqual(["0001_table.sql", "0002_unique.sql"]);
  });

  /**
   * A rollback, against a real bookkeeping table: the previous image's
   * migrations are a prefix of what the database has run. It used to be
   * refused, which made `fly deploy --image <previous tag>` fail in its
   * release command.
   */
  it("applies nothing to a database that is ahead of the build", async () => {
    writeMigration("0001_table.sql", TABLE);
    writeMigration("0002_column.sql", 'ALTER TABLE "t" ADD COLUMN "w" int;\n');

    await applyPendingMigrations(client, dir);

    fs.rmSync(path.join(dir, "0002_column.sql"));

    await expect(applyPendingMigrations(client, dir)).resolves.toEqual({
      applied: [],
      ahead: ["0002_column.sql"],
    });
    expect(await recorded()).toEqual(["0001_table.sql", "0002_column.sql"]);
  });
});
