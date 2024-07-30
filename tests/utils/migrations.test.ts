import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  applyPendingMigrations,
  ensureMigrationsTable,
  findPendingMigrations,
} from "../../utils/migrations.ts";

vi.mock("../../utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** What the runner records for a file's contents. */
function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * A stand-in for a checked-out client whose answers are queued in order.
 *
 * tests/migrate.test.ts drives the whole script with fs mocked; this file
 * drives the shared runner against a real directory, which is the only way
 * to reach the paths a successful deploy never takes — the refusals, the
 * rollback, and a bookkeeping table that is not there at all.
 */
function client(answers: { rows: unknown[] }[] = []) {
  const queue = [...answers];

  const query = vi.fn(
    async (_text: string, _values?: unknown[]) =>
      (queue.shift() ?? { rows: [] }) as any,
  );

  return {
    client: { query } as any,
    statements: () => query.mock.calls.map((call) => call[0]),
  };
}

/**
 * A real directory of real files, because the thing under test is partly
 * fs itself: which names are listed, in what order, and what a filename the
 * runner refuses looks like on disk.
 */
let DIR: string;

function writeMigration(name: string, sql: string): void {
  fs.writeFileSync(path.join(DIR, name), sql);
}



describe("migration runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    DIR = fs.mkdtempSync(path.join(os.tmpdir(), "osg-migrations-"));
  });

  afterEach(() => {
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  describe("readMigrationFiles, through the runner", () => {
    /**
     * Filename order is the run order, and string sort only agrees with
     * numeric order while every name is padded to the same width:
     * "10_x.sql" sorts before "9_x.sql". A run that gets that wrong records
     * its files as applied, so the mistake cannot be undone afterwards.
     */
    it("refuses a filename without a four-digit prefix", async () => {
      writeMigration("9_late.sql", "SELECT 1;");

      await expect(
        applyPendingMigrations(client().client, DIR),
      ).rejects.toThrow("does not start with a four-digit");
    });

    it("ignores anything that is not a .sql file", async () => {
      writeMigration("0001_init.sql", "CREATE TABLE t ();");
      writeMigration("README.md", "not a migration");
      writeMigration(".DS_Store", "not a migration either");

      const c = client();

      await applyPendingMigrations(c.client, DIR);

      expect(c.statements()).toContain("CREATE TABLE t ();");
    });
  });

  describe("verifyAppliedMigrations, through the runner", () => {
    /**
     * The whole cost of the original problem was that nothing failed: an
     * applied migration could be edited afterwards and no database ever
     * found out, so every environment held a different schema depending on
     * when it last ran.
     */
    it("refuses to go on when an applied migration has been edited", async () => {
      writeMigration("0001_init.sql", "what it is now");

      const c = client([
        { rows: [{ name: "0001_init.sql", checksum: checksum("what it was") }] },
      ]);

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        /0001_init\.sql has changed since it was applied/,
      );

      // Refused before anything ran, not partway through.
      expect(c.statements()).not.toContain("BEGIN");
    });

    it("refuses when an applied migration's file has gone", async () => {

      const c = client([
        { rows: [{ name: "0001_init.sql", checksum: checksum("anything") }] },
      ]);

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        /0001_init\.sql has been applied but is no longer in/,
      );
    });

    // Every database that predates the "checksum" column has NULL there.
    // Verifying those would fail every existing deployment on the first run.
    it("leaves a row recorded before checksums existed alone", async () => {
      writeMigration("0001_init.sql", "CREATE TABLE t ();");

      const c = client([
        { rows: [{ name: "0001_init.sql", checksum: null }] },
      ]);

      await expect(
        applyPendingMigrations(c.client, DIR),
      ).resolves.toBeUndefined();

      // Nothing to verify and nothing pending, so nothing ran.
      expect(c.statements()).not.toContain("BEGIN");
    });

    // Both problems are reported together rather than one run at a time.
    it("reports every mismatch it found in one error", async () => {
      writeMigration("0001_init.sql", "edited");

      const c = client([
        {
          rows: [
            { name: "0001_init.sql", checksum: checksum("original") },
            { name: "0002_gone.sql", checksum: checksum("gone") },
          ],
        },
      ]);

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        /0001_init\.sql has changed[\s\S]*0002_gone\.sql has been applied/,
      );
    });
  });

  describe("applyPendingMigrations", () => {
    it("runs each pending file in its own transaction, under UTC", async () => {
      writeMigration("0001_init.sql", "CREATE TABLE t ();");

      const c = client();

      await applyPendingMigrations(c.client, DIR);

      expect(c.statements()).toEqual([
        'SELECT "name", "checksum" FROM "migrations"',
        "BEGIN",
        "SET LOCAL TIME ZONE 'UTC'",
        "CREATE TABLE t ();",
        'INSERT INTO "migrations" ("name", "checksum") VALUES ($1, $2)',
        "COMMIT",
      ]);
    });

    it("skips a file that has already been applied", async () => {
      writeMigration("0001_init.sql", "CREATE TABLE t ();");

      const c = client([
        { rows: [{ name: "0001_init.sql", checksum: null }] },
      ]);

      await applyPendingMigrations(c.client, DIR);

      expect(c.statements()).not.toContain("BEGIN");
    });

    /**
     * The transaction per file is what keeps a failure from committing half
     * a migration, and the rollback is guarded because a connection that has
     * died fails that too — its error would replace the migration's, which
     * is the one worth reading.
     */
    it("rolls back and rethrows the migration's own error", async () => {
      writeMigration("0001_init.sql", "INVALID SQL;");

      const query = vi.fn(async (text: string) => {
        if (text === "INVALID SQL;") throw new Error("syntax error");
        return { rows: [] } as any;
      });

      await expect(applyPendingMigrations({ query } as any, DIR)).rejects.toThrow(
        "syntax error",
      );

      expect(query.mock.calls.map((call) => call[0])).toContain("ROLLBACK");
    });

    it("keeps the migration's error when the rollback fails too", async () => {
      writeMigration("0001_init.sql", "INVALID SQL;");

      const query = vi.fn(async (text: string) => {
        if (text === "INVALID SQL;") throw new Error("syntax error");
        if (text === "ROLLBACK") throw new Error("connection is dead");
        return { rows: [] } as any;
      });

      await expect(applyPendingMigrations({ query } as any, DIR)).rejects.toThrow(
        "syntax error",
      );
    });
  });

  describe("findPendingMigrations", () => {
    it("lists the files the database has not recorded", async () => {
      writeMigration("0001_init.sql", "SELECT 1;");
      writeMigration("0002_next.sql", "SELECT 2;");

      const c = client([{ rows: [{ name: "0001_init.sql" }] }]);

      await expect(findPendingMigrations(c.client, DIR)).resolves.toEqual(
        ["0002_next.sql"],
      );
    });

    /**
     * A database with no bookkeeping table has applied nothing, which is
     * what a fresh install looks like before `npm run migrate` has ever run
     * — the loudest version of this answer rather than an error.
     */
    it("treats a missing bookkeeping table as nothing applied", async () => {
      writeMigration("0001_init.sql", "SELECT 1;");

      const query = vi.fn(async () => {
        throw Object.assign(new Error('relation "migrations" does not exist'), {
          code: "42P01",
        });
      });

      await expect(findPendingMigrations({ query } as any, DIR)).resolves.toEqual([
        "0001_init.sql",
      ]);
    });

    // Anything else is left to the caller: this cannot tell an unreachable
    // database from a stale one, and only the first is survivable.
    it("rethrows any other failure", async () => {
      const query = vi.fn(async () => {
        throw new Error("connection refused");
      });

      await expect(findPendingMigrations({ query } as any, DIR)).rejects.toThrow(
        "connection refused",
      );
    });
  });

  describe("ensureMigrationsTable", () => {
    // The column is added with ALTER rather than by a numbered migration:
    // CREATE TABLE IF NOT EXISTS does nothing to a database that already has
    // the table, so a fresh one would get the column and every existing one
    // would not.
    it("creates the table and adds the checksum column", async () => {
      const c = client();

      await ensureMigrationsTable(c.client);

      const statements = c.statements().join("\n");

      expect(statements).toContain('CREATE TABLE IF NOT EXISTS "migrations"');
      expect(statements).toContain('ADD COLUMN IF NOT EXISTS "checksum"');
    });
  });
});
