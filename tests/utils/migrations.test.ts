import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import logger from "../../utils/logger.ts";
import {
  CONCURRENT_LOCK_TIMEOUT,
  applyPendingMigrations,
  ensureMigrationsTable,
  findPendingMigrations,
} from "../../utils/migrations.ts";

vi.mock("../../utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const loggedWarn = vi.mocked(logger).warn;
const loggedError = vi.mocked(logger).error;

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
 * A client that answers by statement rather than by position.
 *
 * A file outside a transaction is surrounded by queries of the runner's own —
 * the session settings it saves and puts back, the INVALID-index check —
 * and a queue would make every one of these tests restate their order. Only
 * the answers that matter are given; everything else gets no rows.
 */
function scripted(
  answer: (text: string) => { rows: unknown[] } | Error | undefined = () =>
    undefined,
) {
  const query = vi.fn(async (text: string, _values?: unknown[]) => {
    const given = answer(text);

    if (given instanceof Error) throw given;
    if (given) return given as any;

    // The session as migrate.ts leaves it: its DDL bound, the server's zone.
    if (text.includes("current_setting(")) {
      return {
        rows: [{ timeZone: "Europe/Prague", lockTimeout: "5s" }],
      } as any;
    }

    return { rows: [] } as any;
  });

  return {
    client: { query } as any,
    statements: () => query.mock.calls.map((call) => call[0]),
    calls: () => query.mock.calls,
  };
}

/** The opt-out, as a file's first line has to spell it. */
const MARKER = "-- migrate:no-transaction";

const CONCURRENT_INDEX =
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_plays_x" ON "plays" ("x");';

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

    /**
     * A gap: the file has gone from *below* one that is still here, so this
     * is not an older build but a migration deleted or renamed out from
     * under a database that ran it. Its schema is still in there, and a
     * renamed copy would run a second time.
     */
    it("refuses when an applied migration's file has gone from below a newer one", async () => {
      writeMigration("0001_init.sql", "SELECT 1;");
      writeMigration("0003_next.sql", "SELECT 3;");

      const c = client([
        {
          rows: [
            { name: "0001_init.sql", checksum: checksum("SELECT 1;") },
            { name: "0002_gone.sql", checksum: checksum("anything") },
            { name: "0003_next.sql", checksum: checksum("SELECT 3;") },
          ],
        },
      ]);

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        /0002_gone\.sql has been applied but is no longer in .*0003_next\.sql/,
      );
      expect(c.statements()).not.toContain("BEGIN");
    });

    /**
     * The advice this used to give — "clear its row if the migration is
     * genuinely gone" — is the one thing not to do. The row is the only
     * record that the schema holds what the file did; clearing it hides that
     * rather than undoing it, and if the file ever comes back the next deploy
     * applies it a second time.
     */
    it("does not tell anybody to clear the row", async () => {
      writeMigration("0003_next.sql", "SELECT 3;");

      const c = client([
        {
          rows: [
            { name: "0002_gone.sql", checksum: null },
            { name: "0003_next.sql", checksum: null },
          ],
        },
      ]);

      const failure = await applyPendingMigrations(c.client, DIR).catch(
        (error: Error) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toMatch(/clear its row/i);
      expect((failure as Error).message).toMatch(/restore/i);
    });

    /**
     * A missing file is reported whatever the row holds, and the null guard
     * used to sit above the check so it was not. The databases that lose by
     * that are exactly the ones old enough to predate the "checksum" column —
     * the ones nobody has looked at in a while — and what they lose is the
     * report that a migration they ran is no longer in the repository at all.
     * "What has run" is a question about names; no checksum is needed to
     * answer it.
     */
    it("refuses when a file recorded before checksums existed has gone", async () => {
      writeMigration("0002_next.sql", "SELECT 2;");

      const c = client([
        {
          rows: [
            { name: "0001_init.sql", checksum: null },
            { name: "0002_next.sql", checksum: null },
          ],
        },
      ]);

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        /0001_init\.sql has been applied but is no longer in/,
      );
    });

    /**
     * Not "the database is ahead": no build of this app has ever had an
     * empty migrations/ directory, so a build with none is missing them, and
     * "ahead" would be a claim about a history this build cannot see at all.
     */
    it("refuses when the directory holds no migrations at all", async () => {
      const c = client([
        { rows: [{ name: "0001_init.sql", checksum: checksum("anything") }] },
      ]);

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        /0001_init\.sql has been applied, and .* holds no migrations at all/,
      );
    });

    /**
     * Only a name this runner could have recorded counts as a newer
     * migration. A row inserted by hand ("manual-fix") sorts above every
     * numbered file, and reading it as "the database is ahead" would turn a
     * mistake into a warning on every boot.
     */
    it("does not read a name no migration could have as the database being ahead", async () => {
      writeMigration("0001_init.sql", "SELECT 1;");

      const c = client([
        {
          rows: [
            { name: "0001_init.sql", checksum: checksum("SELECT 1;") },
            { name: "manual-fix", checksum: null },
          ],
        },
      ]);

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        /manual-fix is recorded as applied, but no migration file could have/,
      );
    });

    // Every database that predates the "checksum" column has NULL there.
    // Verifying those would fail every existing deployment on the first run.
    it("leaves a row recorded before checksums existed alone", async () => {
      writeMigration("0001_init.sql", "CREATE TABLE t ();");

      const c = client([
        { rows: [{ name: "0001_init.sql", checksum: null }] },
      ]);

      await expect(applyPendingMigrations(c.client, DIR)).resolves.toEqual({
        applied: [],
        ahead: [],
      });

      // Nothing to verify and nothing pending, so nothing ran.
      expect(c.statements()).not.toContain("BEGIN");
    });

    // Both problems are reported together rather than one run at a time. The
    // missing file sorts below one that is still here: above every file, it
    // would be a newer migration rather than a missing one — see the block
    // below.
    it("reports every mismatch it found in one error", async () => {
      writeMigration("0001_init.sql", "edited");
      writeMigration("0003_next.sql", "SELECT 3;");

      const c = client([
        {
          rows: [
            { name: "0001_init.sql", checksum: checksum("original") },
            { name: "0002_gone.sql", checksum: checksum("gone") },
            { name: "0003_next.sql", checksum: checksum("SELECT 3;") },
          ],
        },
      ]);

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        /0001_init\.sql has changed[\s\S]*0002_gone\.sql has been applied/,
      );
    });
  });

  /**
   * A rollback. `fly deploy --image <previous tag>` runs the release command
   * too, and that is the *previous* image's migrate.ts against a database
   * that has already applied the bad release's migration. It used to refuse
   * — "has been applied but is no longer in" — and exit 1, so the rollback
   * README.md promises could not happen at all. Nothing was being protected:
   * expand/contract (see fly.toml) already means the release before a
   * migration runs against the schema after it, because it has to for the
   * length of every rolling restart.
   */
  describe("a database ahead of this build", () => {
    it("applies nothing and succeeds", async () => {
      writeMigration("0001_init.sql", "SELECT 1;");
      writeMigration("0002_next.sql", "SELECT 2;");

      const c = client([
        {
          rows: [
            { name: "0001_init.sql", checksum: checksum("SELECT 1;") },
            { name: "0002_next.sql", checksum: checksum("SELECT 2;") },
            { name: "0003_newer.sql", checksum: checksum("SELECT 3;") },
          ],
        },
      ]);

      await expect(applyPendingMigrations(c.client, DIR)).resolves.toEqual({
        applied: [],
        ahead: ["0003_newer.sql"],
      });

      expect(c.statements()).not.toContain("BEGIN");
      expect(loggedError).not.toHaveBeenCalled();
    });

    // Said, rather than passed over: a build older than its database is
    // expected after a rollback and worth a line anywhere else.
    it("says so, naming what it does not have", async () => {
      writeMigration("0001_init.sql", "SELECT 1;");

      const c = client([
        {
          rows: [
            { name: "0001_init.sql", checksum: checksum("SELECT 1;") },
            { name: "0002_newer.sql", checksum: null },
            { name: "0003_newest.sql", checksum: null },
          ],
        },
      ]);

      await applyPendingMigrations(c.client, DIR);

      expect(loggedWarn).toHaveBeenCalledWith(
        expect.stringMatching(
          /database is ahead of this build[\s\S]*0002_newer\.sql, 0003_newest\.sql[\s\S]*0001_init\.sql/,
        ),
      );
    });

    // The files this build does have are still history, and still checked.
    it("still refuses a file of its own that has been edited", async () => {
      writeMigration("0001_init.sql", "what it is now");

      const c = client([
        {
          rows: [
            { name: "0001_init.sql", checksum: checksum("what it was") },
            { name: "0002_newer.sql", checksum: null },
          ],
        },
      ]);

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        /0001_init\.sql has changed since it was applied/,
      );
    });

    // A newer migration on top does not excuse a hole underneath it.
    it("still refuses a gap below the newest file it has", async () => {
      writeMigration("0001_init.sql", "SELECT 1;");
      writeMigration("0003_next.sql", "SELECT 3;");

      const c = client([
        {
          rows: [
            { name: "0001_init.sql", checksum: null },
            { name: "0002_gone.sql", checksum: null },
            { name: "0003_next.sql", checksum: null },
            { name: "0004_newer.sql", checksum: null },
          ],
        },
      ]);

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        /0002_gone\.sql has been applied but is no longer in/,
      );
    });

    /**
     * index.ts asks the same question at boot, and a machine started on the
     * previous image after a rollback is in exactly this state. It used to be
     * logged as "Applied migrations do not match the files" — an error, for
     * the state a rollback is supposed to leave.
     */
    it("is a warning at boot, with nothing pending", async () => {
      writeMigration("0001_init.sql", "SELECT 1;");

      const c = client([
        {
          rows: [
            { name: "0001_init.sql", checksum: checksum("SELECT 1;") },
            { name: "0002_newer.sql", checksum: null },
          ],
        },
      ]);

      await expect(findPendingMigrations(c.client, DIR)).resolves.toEqual([]);

      expect(loggedError).not.toHaveBeenCalled();
      expect(loggedWarn).toHaveBeenCalledWith(
        expect.stringContaining("database is ahead of this build"),
      );
    });

    it("still reports a gap at boot as a mismatch", async () => {
      writeMigration("0002_next.sql", "SELECT 2;");

      const c = client([
        {
          rows: [
            { name: "0001_gone.sql", checksum: null },
            { name: "0002_next.sql", checksum: null },
          ],
        },
      ]);

      await findPendingMigrations(c.client, DIR);

      expect(loggedError).toHaveBeenCalledWith(
        expect.stringContaining("do not match"),
        expect.objectContaining({
          message: expect.stringContaining("0001_gone.sql has been applied"),
        }),
      );
    });
  });

  describe("migration order, through the runner", () => {
    /**
     * "Pending" was decided by name alone, so a file numbered below something
     * already applied simply ran — and was then recorded, which is what makes
     * it unrecoverable: no other database will ever reproduce that schema,
     * because every database that has not run the file yet will run it in
     * order. Two branches each adding 0042 and one of them renumbered to 0043
     * is all it takes.
     */
    it("refuses a pending file that sorts below an applied one", async () => {
      writeMigration("0001_late_addition.sql", "SELECT 1;");
      writeMigration("0003_already_out.sql", "SELECT 3;");

      const c = client([
        {
          rows: [{ name: "0003_already_out.sql", checksum: checksum("SELECT 3;") }],
        },
      ]);

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        /0001_late_addition\.sql[\s\S]*sorts before 0003_already_out\.sql/,
      );

      // Refused before anything ran, so the schema is where it was found.
      expect(c.statements()).not.toContain("BEGIN");
    });

    // The ordinary case has to stay ordinary: a file above everything applied
    // is exactly what every deploy adds.
    it("applies a pending file that sorts above every applied one", async () => {
      writeMigration("0001_init.sql", "SELECT 1;");
      writeMigration("0002_next.sql", "SELECT 2;");

      const c = client([
        { rows: [{ name: "0001_init.sql", checksum: checksum("SELECT 1;") }] },
      ]);

      await applyPendingMigrations(c.client, DIR);

      expect(c.statements()).toContain("SELECT 2;");
    });

    // Every file is pending on a fresh install, and none of them is out of
    // order: there is nothing applied for them to sort behind.
    it("says nothing about order when nothing has been applied", async () => {
      writeMigration("0001_init.sql", "SELECT 1;");
      writeMigration("0002_next.sql", "SELECT 2;");

      const c = client();

      await applyPendingMigrations(c.client, DIR);

      expect(c.statements()).toContain("SELECT 1;");
      expect(c.statements()).toContain("SELECT 2;");
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

  /**
   * Every file used to run inside BEGIN, which makes CREATE INDEX
   * CONCURRENTLY impossible — Postgres refuses it in a transaction block — so
   * the next index on "plays" or "ratings" would have had to hold a SHARE lock
   * for its whole build and stop every vote and play INSERT while it ran.
   */
  describe("a file outside a transaction", () => {
    it("runs without BEGIN, and is recorded only after it has worked", async () => {
      const sql = `${MARKER}\n${CONCURRENT_INDEX}\n`;
      writeMigration("0001_index.sql", sql);

      const c = scripted();

      await expect(applyPendingMigrations(c.client, DIR)).resolves.toEqual({
        applied: ["0001_index.sql"],
        ahead: [],
      });

      const statements = c.statements();
      const run = statements.indexOf(sql);
      const record = statements.findIndex((text) =>
        text.startsWith('INSERT INTO "migrations"'),
      );

      expect(statements).not.toContain("BEGIN");
      expect(statements).not.toContain("COMMIT");
      expect(run).toBeGreaterThan(-1);
      expect(record).toBeGreaterThan(run);
      expect(c.calls()[record][1]).toEqual(["0001_index.sql", checksum(sql)]);
      expect(vi.mocked(logger).info).toHaveBeenCalledWith(
        "Applying migration: 0001_index.sql (outside a transaction)",
      );
    });

    // With no transaction around it there is nothing to roll back — the row
    // is the only thing that can be withheld, so it must be.
    it("records nothing when the statement fails", async () => {
      writeMigration("0001_index.sql", `${MARKER}\n${CONCURRENT_INDEX}\n`);

      const c = scripted((text) =>
        text.includes("CREATE INDEX") ? new Error("could not build") : undefined,
      );

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        "could not build",
      );

      expect(
        c.statements().some((text) => text.startsWith('INSERT INTO "migrations"')),
      ).toBe(false);
    });

    /**
     * migrate.ts waits five seconds for a DDL lock, because a waiting ALTER
     * TABLE queues every later query behind it. A concurrent build's lock
     * blocks no read or write, and cut off at five seconds by any slow query
     * it would leave an INVALID index behind — so it waits its own bound, and
     * the caller's is put back for whatever runs next.
     */
    it("gives a concurrent build its own lock bound and puts the caller's back", async () => {
      writeMigration("0001_index.sql", `${MARKER}\n${CONCURRENT_INDEX}\n`);

      const c = scripted();

      await applyPendingMigrations(c.client, DIR);

      const configured = c
        .calls()
        .filter(([text]) => text.includes("set_config("))
        .map(([, values]) => values);

      expect(configured).toEqual([
        [CONCURRENT_LOCK_TIMEOUT],
        ["Europe/Prague", "5s"],
      ]);
    });

    // Put back rather than RESET, which would restore the server default —
    // no bound at all — for every file after this one.
    it("puts the session back even when the statement fails", async () => {
      writeMigration("0001_index.sql", `${MARKER}\n${CONCURRENT_INDEX}\n`);

      const c = scripted((text) =>
        text.includes("CREATE INDEX") ? new Error("could not build") : undefined,
      );

      await applyPendingMigrations(c.client, DIR).catch(() => {});

      expect(c.calls().at(-1)?.[1]).toEqual(["Europe/Prague", "5s"]);
    });

    // SET LOCAL means nothing outside a transaction, so UTC is set for the
    // session and taken back afterwards.
    it("runs under UTC like every other file", async () => {
      writeMigration("0001_index.sql", `${MARKER}\n${CONCURRENT_INDEX}\n`);

      const c = scripted();

      await applyPendingMigrations(c.client, DIR);

      const statements = c.statements();
      const utc = statements.findIndex((text) =>
        text.includes("set_config('TimeZone', 'UTC', false)"),
      );

      expect(utc).toBeGreaterThan(-1);
      expect(utc).toBeLessThan(statements.findIndex((text) => text.includes("CREATE INDEX")));
    });

    // A plain ALTER TABLE given the marker by mistake still has to give up
    // in seconds, not stall the site for a minute.
    it("leaves the caller's lock bound alone for a statement that is not concurrent", async () => {
      writeMigration("0001_vacuum.sql", `${MARKER}\nVACUUM ANALYZE "plays";\n`);

      const c = scripted();

      await applyPendingMigrations(c.client, DIR);

      const [first] = c
        .calls()
        .filter(([text]) => text.includes("set_config("))
        .map(([, values]) => values);

      expect(first).toEqual(["5s"]);
    });

    /**
     * Postgres runs several statements sent as one query as one implicit
     * transaction — so a second CREATE INDEX CONCURRENTLY is refused there as
     * it is after BEGIN — and a file with no transaction around it has
     * nothing to roll back to if it fails halfway.
     */
    it("refuses more than one statement, before anything runs", async () => {
      writeMigration(
        "0001_index.sql",
        `${MARKER}\n${CONCURRENT_INDEX}\n` +
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_y" ON "plays" ("y");\n',
      );

      const c = scripted();

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        /0001_index\.sql is marked "-- migrate:no-transaction" and holds 2 statements/,
      );

      expect(c.statements()).toEqual(['SELECT "name", "checksum" FROM "migrations"']);
    });

    it("counts the statement after the last semicolon too", async () => {
      writeMigration("0001_two.sql", `${MARKER}\nSELECT 1; SELECT 2`);

      await expect(
        applyPendingMigrations(scripted().client, DIR),
      ).rejects.toThrow(/holds 2 statements/);
    });

    // A semicolon only ends a statement outside strings, quoted identifiers,
    // comments and dollar quotes — a partial index's WHERE can hold one.
    it("does not count semicolons that end no statement", async () => {
      const sql = [
        MARKER,
        "-- A comment; with a semicolon in it.",
        "/* and /* a nested; one */ as well; */",
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "we;ird"',
        '  ON "games" ("title")',
        `  WHERE "title" <> 'a;b' AND "title" <> 'it''s;'`,
        `    AND "slug" <> E'back\\'slash;' AND "developer" <> $x$c;d$x$;`,
        "",
      ].join("\n");
      writeMigration("0001_index.sql", sql);

      const c = scripted();

      await applyPendingMigrations(c.client, DIR);

      expect(c.statements()).toContain(sql);
    });

    it("refuses the marker anywhere but the first line", async () => {
      writeMigration(
        "0001_index.sql",
        `-- An index for the most-played list.\n${MARKER}\n${CONCURRENT_INDEX}\n`,
      );

      await expect(
        applyPendingMigrations(scripted().client, DIR),
      ).rejects.toThrow(/0001_index\.sql has "-- migrate:no-transaction" on line 2/);
    });

    it("refuses a marked file with no statement in it", async () => {
      writeMigration("0001_empty.sql", `${MARKER}\n-- to do\n`);

      await expect(
        applyPendingMigrations(scripted().client, DIR),
      ).rejects.toThrow(/holds no statement/);
    });

    // Line endings are not content — see checksumOf — and a CRLF checkout
    // must not quietly put the file back inside a transaction.
    it("reads the marker through CRLF line endings", async () => {
      writeMigration("0001_index.sql", `${MARKER}\r\n${CONCURRENT_INDEX}\r\n`);

      const c = scripted();

      await applyPendingMigrations(c.client, DIR);

      expect(c.statements()).not.toContain("BEGIN");
    });

    // A malformed file late in the list must not leave the ones before it
    // applied: every pending file is checked before the first one runs.
    it("checks every pending file before running the first", async () => {
      writeMigration("0001_table.sql", "CREATE TABLE t ();");
      writeMigration("0002_index.sql", `${MARKER}\nSELECT 1; SELECT 2;\n`);

      const c = scripted();

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        /0002_index\.sql is marked/,
      );

      expect(c.statements()).not.toContain("BEGIN");
      expect(c.statements()).not.toContain("CREATE TABLE t ();");
    });

    /**
     * A concurrent build that fails keeps its index, marked INVALID, and IF
     * NOT EXISTS counts that as existing — so running the file again
     * "succeeds" over a broken index. Verified against Postgres 18. The row
     * is what would make that permanent, so it is withheld.
     */
    it("records nothing while an INVALID index is there", async () => {
      writeMigration("0001_index.sql", `${MARKER}\n${CONCURRENT_INDEX}\n`);

      const c = scripted((text) =>
        text.includes("pg_index")
          ? { rows: [{ index: 'public."idx_plays_x"' }] }
          : undefined,
      );

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        /0001_index\.sql ran, but public\."idx_plays_x" is INVALID[\s\S]*DROP INDEX CONCURRENTLY IF EXISTS public\."idx_plays_x";/,
      );

      expect(
        c.statements().some((text) => text.startsWith('INSERT INTO "migrations"')),
      ).toBe(false);
    });

    /**
     * migrate.ts retries a lock timeout by itself. A build that timed out
     * waiting for older transactions has already left its INVALID index, so
     * the retry would be exactly the IF NOT EXISTS run above — which is why
     * this failure is not allowed to carry the lock error's code.
     */
    it("reports a failed build that left an INVALID index, without the code a retry looks for", async () => {
      writeMigration("0001_index.sql", `${MARKER}\n${CONCURRENT_INDEX}\n`);

      const lockTimeout = Object.assign(
        new Error("canceling statement due to lock timeout"),
        { code: "55P03" },
      );

      const c = scripted((text) => {
        if (text.includes("CREATE INDEX")) return lockTimeout;
        if (text.includes("pg_index")) {
          return { rows: [{ index: 'public."idx_plays_x"' }] };
        }
        return undefined;
      });

      const failure = (await applyPendingMigrations(c.client, DIR).catch(
        (error: unknown) => error,
      )) as Error & { code?: string };

      expect(failure.code).toBeUndefined();
      expect(failure.cause).toBe(lockTimeout);
      expect(failure.message).toMatch(
        /failed outside a transaction \(canceling statement due to lock timeout\) and left public\."idx_plays_x" behind, INVALID/,
      );
    });

    // Nothing left behind — the wait for the table's lock gave up before the
    // build began — so a retry is safe, and the error goes out as it came.
    it("passes a failure that left nothing behind through as it came", async () => {
      writeMigration("0001_index.sql", `${MARKER}\n${CONCURRENT_INDEX}\n`);

      const lockTimeout = Object.assign(
        new Error("canceling statement due to lock timeout"),
        { code: "55P03" },
      );

      const c = scripted((text) =>
        text.includes("CREATE INDEX") ? lockTimeout : undefined,
      );

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toBe(
        lockTimeout,
      );
    });

    // A connection that has died fails the check and the restore as well,
    // and neither of their errors is the one worth reading.
    it("keeps the statement's own error when the connection has gone", async () => {
      writeMigration("0001_index.sql", `${MARKER}\n${CONCURRENT_INDEX}\n`);

      const c = scripted((text) => {
        if (text.includes("CREATE INDEX")) return new Error("connection terminated");
        if (text.includes("pg_index") || text.includes("set_config('TimeZone', $1")) {
          return new Error("not connected");
        }
        return undefined;
      });

      await expect(applyPendingMigrations(c.client, DIR)).rejects.toThrow(
        "connection terminated",
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
