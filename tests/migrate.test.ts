import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import db from "../db";

// Migrations run on one checked-out client so BEGIN/COMMIT cannot land on
// different connections. The client shares the pool's query spy, so the
// assertions below read the same call list either way.
const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../db", () => ({
  default: {
    query,
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
    end: vi.fn(),
  },
}));

vi.mock("fs", () => ({
  default: {
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

vi.mock("path", () => ({
  default: {
    join: vi.fn(),
    dirname: vi.fn(),
  },
}));

vi.mock("url", () => ({
  fileURLToPath: vi.fn(),
}));

const mockDb = vi.mocked(db);
const mockFs = vi.mocked(fs);
const mockPath = vi.mocked(path);

const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

/**
 * Queues answers for the four statements runMigrations issues before it looks
 * at a single migration file: lifting the pool's statement timeout for this
 * session (a migration is not a page view — see db.ts), taking the advisory
 * lock that keeps two runs from applying the same file, creating the
 * bookkeeping table and giving it its "checksum" column. Whatever a test
 * queues on the returned chain answers the "which migrations are applied"
 * select onwards.
 */
function queuePrelude() {
  const chain = mockDb.query as any;

  chain
    .mockResolvedValueOnce({ rows: [] }) // SET statement_timeout = 0
    .mockResolvedValueOnce({ rows: [] }) // SELECT pg_advisory_lock($1)
    .mockResolvedValueOnce({ rows: [] }) // CREATE TABLE IF NOT EXISTS "migrations"
    .mockResolvedValueOnce({ rows: [] }); // ALTER TABLE ... ADD COLUMN "checksum"

  return chain;
}

/** What utils/migrations.ts records for a file's contents. */
function checksum(sql: string) {
  return createHash("sha256").update(sql).digest("hex");
}

describe("Migration System", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPath.dirname.mockReturnValue("/test/dir");
    mockPath.join.mockImplementation((...args) => args.join("/"));
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("runMigrations", () => {
    it("should create migrations table if it doesn't exist", async () => {
      queuePrelude();
      mockFs.readdirSync.mockReturnValue([]);

      await import("../migrate");

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS "migrations"'),
      );
    });

    it("holds an advisory lock for the whole run and gives it back", async () => {
      queuePrelude();
      mockFs.readdirSync.mockReturnValue([]);

      await import("../migrate");

      expect(mockDb.query).toHaveBeenCalledWith(
        "SELECT pg_advisory_lock($1)",
        [12345],
      );
      expect(mockDb.query).toHaveBeenCalledWith(
        "SELECT pg_advisory_unlock($1)",
        [12345],
      );
    });

    it("lifts the statement timeout before waiting on the lock", async () => {
      queuePrelude();
      mockFs.readdirSync.mockReturnValue([]);

      await import("../migrate");

      const statements = (mockDb.query as any).mock.calls.map(
        (call: unknown[]) => call[0],
      );

      // Waiting for another deploy to finish is itself a statement, so the
      // pool's 15-second cap has to be gone before the lock is asked for.
      expect(statements.indexOf("SET statement_timeout = 0")).toBeLessThan(
        statements.indexOf("SELECT pg_advisory_lock($1)"),
      );
    });

    it("puts the statement timeout back before the client is reused", async () => {
      queuePrelude();
      mockFs.readdirSync.mockReturnValue([]);

      await import("../migrate");

      const statements = (mockDb.query as any).mock.calls.map(
        (call: unknown[]) => call[0],
      );

      // release() does not reset session state, and db.ts applies the cap
      // only as a connection parameter at connect time — so without this the
      // client would go back into the pool still willing to run a page
      // view's query forever.
      expect(statements).toContain("RESET statement_timeout");
      expect(statements.indexOf("RESET statement_timeout")).toBeGreaterThan(
        statements.indexOf("SET statement_timeout = 0"),
      );
    });

    it("puts the statement timeout back even when a migration fails", async () => {
      queuePrelude().mockResolvedValueOnce({ rows: [] });

      mockFs.readdirSync.mockReturnValue(["0001_init.sql"] as any);
      mockFs.readFileSync.mockReturnValue("INVALID SQL;");

      (mockDb.query as any).mockRejectedValueOnce(new Error("SQL syntax error"));

      await import("../migrate");

      // The failing path is the one that matters: a deploy that aborts here
      // still hands the connection back.
      const statements = (mockDb.query as any).mock.calls.map(
        (call: unknown[]) => call[0],
      );

      expect(statements).toContain("RESET statement_timeout");
    });

    it("should skip already applied migrations", async () => {
      queuePrelude().mockResolvedValueOnce({
        rows: [{ name: "0001_init.sql" }],
      });

      mockFs.readdirSync.mockReturnValue([
        "0001_init.sql",
        "0002_add_images_to_game.sql",
      ] as any);
      mockFs.readFileSync.mockReturnValue("CREATE TABLE test;");

      await import("../migrate");

      expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
      expect(mockFs.readFileSync).toHaveBeenCalledWith(
        "/test/dir/migrations/0002_add_images_to_game.sql",
        "utf-8",
      );
    });

    it("should apply new migrations in order", async () => {
      queuePrelude().mockResolvedValueOnce({ rows: [] });

      mockFs.readdirSync.mockReturnValue([
        "0002_add_images_to_game.sql",
        "0001_init.sql",
        "0003_add_genre_to_game.sql",
      ] as any);

      const migrationSQL = "CREATE TABLE test;";
      mockFs.readFileSync.mockReturnValue(migrationSQL);

      await import("../migrate");

      expect(mockFs.readFileSync).toHaveBeenNthCalledWith(
        1,
        "/test/dir/migrations/0001_init.sql",
        "utf-8",
      );
      expect(mockFs.readFileSync).toHaveBeenNthCalledWith(
        2,
        "/test/dir/migrations/0002_add_images_to_game.sql",
        "utf-8",
      );
      expect(mockFs.readFileSync).toHaveBeenNthCalledWith(
        3,
        "/test/dir/migrations/0003_add_genre_to_game.sql",
        "utf-8",
      );
    });

    it("should execute migration SQL and record it in migrations table", async () => {
      queuePrelude().mockResolvedValueOnce({ rows: [] });

      mockFs.readdirSync.mockReturnValue(["0001_init.sql"] as any);
      const migrationSQL = "CREATE TABLE games (id SERIAL PRIMARY KEY);";
      mockFs.readFileSync.mockReturnValue(migrationSQL);

      await import("../migrate");

      expect(mockDb.query).toHaveBeenCalledWith(migrationSQL);
      expect(mockDb.query).toHaveBeenCalledWith(
        'INSERT INTO "migrations" ("name", "checksum") VALUES ($1, $2)',
        ["0001_init.sql", checksum(migrationSQL)],
      );
    });

    it("gives the bookkeeping table its checksum column either way", async () => {
      queuePrelude();
      mockFs.readdirSync.mockReturnValue([]);

      await import("../migrate");

      // ALTER rather than a numbered migration, and the distinction is the
      // whole reason 0032 had to exist: CREATE TABLE IF NOT EXISTS does
      // nothing to a database that already has the table, so only a fresh one
      // would have got the column.
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('ADD COLUMN IF NOT EXISTS "checksum"'),
      );
    });

    it("refuses to run when an applied migration has been edited", async () => {
      queuePrelude().mockResolvedValueOnce({
        rows: [{ name: "0001_init.sql", checksum: checksum("what it was") }],
      });

      mockFs.readdirSync.mockReturnValue(["0001_init.sql"] as any);
      mockFs.readFileSync.mockReturnValue("what it is now");

      await import("../migrate");

      // Aborts the deploy rather than warning: the entire cost of the
      // original problem was that nothing failed. 0030 was edited after it had
      // been applied and no database ever found out.
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Migration error:",
        expect.objectContaining({
          message: expect.stringContaining("has changed since it was applied"),
        }),
      );
    });

    it("refuses to run when an applied migration's file has gone", async () => {
      queuePrelude().mockResolvedValueOnce({
        rows: [{ name: "0001_init.sql", checksum: checksum("anything") }],
      });

      mockFs.readdirSync.mockReturnValue([]);

      await import("../migrate");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Migration error:",
        expect.objectContaining({
          message: expect.stringContaining("no longer in"),
        }),
      );
    });

    it("leaves rows recorded before checksums existed alone", async () => {
      // Every database that predates the column has NULL here, this one
      // included — verifying it would fail every existing deployment on the
      // first run, which is not what a new safety net may cost.
      queuePrelude().mockResolvedValueOnce({
        rows: [{ name: "0001_init.sql", checksum: null }],
      });

      mockFs.readdirSync.mockReturnValue(["0001_init.sql"] as any);

      await import("../migrate");

      expect(consoleSpy).toHaveBeenCalledWith("All migrations applied.");
      // Nothing pending and nothing to verify, so the file is never opened.
      expect(mockFs.readFileSync).not.toHaveBeenCalled();
    });

    it("should filter only .sql files", async () => {
      queuePrelude().mockResolvedValueOnce({ rows: [] });

      mockFs.readdirSync.mockReturnValue([
        "0001_init.sql",
        "README.md",
        "0002_add_images_to_game.sql",
        "script.js",
        ".DS_Store",
      ] as any);
      mockFs.readFileSync.mockReturnValue("CREATE TABLE test;");

      await import("../migrate");

      expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
      expect(mockFs.readFileSync).toHaveBeenCalledWith(
        "/test/dir/migrations/0001_init.sql",
        "utf-8",
      );
      expect(mockFs.readFileSync).toHaveBeenCalledWith(
        "/test/dir/migrations/0002_add_images_to_game.sql",
        "utf-8",
      );
    });

    it("should log progress messages", async () => {
      queuePrelude().mockResolvedValueOnce({ rows: [] });

      mockFs.readdirSync.mockReturnValue(["0001_init.sql"] as any);
      mockFs.readFileSync.mockReturnValue("CREATE TABLE test;");

      await import("../migrate");

      expect(consoleSpy).toHaveBeenCalledWith(
        "Applying migration: 0001_init.sql",
      );
      expect(consoleSpy).toHaveBeenCalledWith("All migrations applied.");
    });

    it("should handle migration errors gracefully", async () => {
      const error = new Error("Database connection failed");
      (mockDb.query as any).mockRejectedValueOnce(error);

      await import("../migrate");

      expect(consoleErrorSpy).toHaveBeenCalledWith("Migration error:", error);
    });

    it("should handle SQL execution errors", async () => {
      queuePrelude().mockResolvedValueOnce({ rows: [] });

      mockFs.readdirSync.mockReturnValue(["0001_init.sql"] as any);
      mockFs.readFileSync.mockReturnValue("INVALID SQL;");

      const sqlError = new Error("SQL syntax error");
      (mockDb.query as any).mockRejectedValueOnce(sqlError);

      await import("../migrate");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Migration error:",
        sqlError,
      );
    });
  });
});
