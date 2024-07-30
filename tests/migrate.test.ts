import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import db from "../db";

vi.mock("../db", () => ({
  default: {
    query: vi.fn(),
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
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });
      mockFs.readdirSync.mockReturnValue([]);

      await import("../migrate");

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS "migrations"')
      );
    });

    it("should skip already applied migrations", async () => {
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
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
        "utf-8"
      );
    });

    it("should apply new migrations in order", async () => {
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

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
        "utf-8"
      );
      expect(mockFs.readFileSync).toHaveBeenNthCalledWith(
        2,
        "/test/dir/migrations/0002_add_images_to_game.sql",
        "utf-8"
      );
      expect(mockFs.readFileSync).toHaveBeenNthCalledWith(
        3,
        "/test/dir/migrations/0003_add_genre_to_game.sql",
        "utf-8"
      );
    });

    it("should execute migration SQL and record it in migrations table", async () => {
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      mockFs.readdirSync.mockReturnValue(["0001_init.sql"] as any);
      const migrationSQL = "CREATE TABLE games (id SERIAL PRIMARY KEY);";
      mockFs.readFileSync.mockReturnValue(migrationSQL);

      await import("../migrate");

      expect(mockDb.query).toHaveBeenCalledWith(migrationSQL);
      expect(mockDb.query).toHaveBeenCalledWith(
        'INSERT INTO "migrations" ("name") VALUES ($1)',
        ["0001_init.sql"]
      );
    });

    it("should filter only .sql files", async () => {
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

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
        "utf-8"
      );
      expect(mockFs.readFileSync).toHaveBeenCalledWith(
        "/test/dir/migrations/0002_add_images_to_game.sql",
        "utf-8"
      );
    });

    it("should log progress messages", async () => {
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      mockFs.readdirSync.mockReturnValue(["0001_init.sql"] as any);
      mockFs.readFileSync.mockReturnValue("CREATE TABLE test;");

      await import("../migrate");

      expect(consoleSpy).toHaveBeenCalledWith(
        "Applying migration: 0001_init.sql"
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
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      mockFs.readdirSync.mockReturnValue(["0001_init.sql"] as any);
      mockFs.readFileSync.mockReturnValue("INVALID SQL;");

      const sqlError = new Error("SQL syntax error");
      (mockDb.query as any).mockRejectedValueOnce(sqlError);

      await import("../migrate");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Migration error:",
        sqlError
      );
    });
  });
});
